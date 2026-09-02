import { isSiteGroundChallenge } from './listing-retry.ts';
import { fetchRelayHosts } from './registry.ts';

const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const MAX_REDIRECTS = 10;
export const RELAY_ORIGIN_COOKIE_HEADER = 'x-relay-origin-cookie';
/** HTML listings and fichas. SiteGround treats this as a browser and may 202 a `/wp-json/` URL. */
export const HTML_ACCEPT = 'text/html,application/json;q=0.9,*/*;q=0.8';
/**
 * WordPress REST. SiteGround 202s HTML captcha when Accept includes text/html
 * or a wildcard type; JSON-only plus the ingestion User-Agent returns the CPT JSON.
 */
export const JSON_DOCUMENT_ACCEPT = 'application/json';

/** Same-origin cookies kept for the process, including across relay hops. */
const originCookieJar = new Map<string, string>();

export function resetOriginCookieJar(): void {
  originCookieJar.clear();
}

/** Preserve HTTP facts for source-local retry policies; no retries by default. */
export class HttpError extends Error {
  constructor(public readonly status: number, url: string, public readonly retryAfter: string | null = null) {
    super(`HTTP ${status} al pedir ${url}`);
  }
}

export type FetchRelayTarget = {
  requestUrl: string;
  token: string;
};

/**
 * Direct cookie-aware fetch, or a configured fetch relay for hosts that a
 * source marked with `useFetchRelay`.
 *
 * Ordinary URLs always use the current direct transport. Relay hosts use the
 * Worker only when URL and token are both set. Callers keep passing the
 * official source URL; this function never rewrites it into a workers.dev
 * address. Error statuses are never retried, and a 403 on a direct host is
 * never sent to the relay.
 *
 * Native fetch does not persist Set-Cookie across redirects. www.march.es
 * answers a same-URL 307 with a session cookie; the direct client follows
 * redirects itself and sends cookies only back to the origin that set them.
 * The relay Worker does the same cookie replay for any public HTTPS target.
 *
 * Imperva-protected hosts also set visitor/session cookies on 200 and 403.
 * Those must be reused on later pages of the same origin; otherwise each
 * getText looks like a new visitor and the CDN answers 403 (Flooding).
 * Direct fetches keep a process jar. Relay fetches send/receive
 * `x-relay-origin-cookie` only to the authenticated Worker, never as
 * browser `Cookie`/`Set-Cookie`.
 */
export async function getText(url: string, timeoutMs = 30_000, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const relay = resolveFetchRelay(url, env);
    if (relay) return await readViaRelay(url, relay, controller.signal);
    return await readFollowingRedirects(url, controller.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`tiempo agotado al pedir ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `undefined` → direct transport. Throws if this host uses the relay but the
 * relay is only half-configured or not https.
 */
export function resolveFetchRelay(url: string, env: NodeJS.ProcessEnv = process.env): FetchRelayTarget | undefined {
  const parsed = parseHttpUrl(url);
  if (!parsed || !isFetchRelayHost(parsed.hostname)) return undefined;
  const relayUrl = env.INGEST_FETCH_RELAY_URL?.trim() ?? '';
  const token = env.INGEST_FETCH_RELAY_TOKEN?.trim() ?? '';
  if (!relayUrl && !token) return undefined;
  if (!relayUrl || !token) {
    throw new Error(`relay de fetch incompleto al pedir ${url}`);
  }
  const relay = parseHttpUrl(relayUrl);
  if (!relay || relay.protocol !== 'https:') {
    throw new Error(`relay de fetch inválido al pedir ${url}`);
  }
  relay.searchParams.set('url', url);
  return { requestUrl: relay.href, token };
}

export function isFetchRelayHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return fetchRelayHosts().includes(host);
}

/** Origin `Accept` for this URL. `/wp-json/` is JSON-only so SiteGround does not serve HTML 202. */
export function acceptHeaderForUrl(url: string): string {
  try {
    if (new URL(url).pathname.toLowerCase().includes('/wp-json/')) return JSON_DOCUMENT_ACCEPT;
  } catch {
    // invalid URL: keep the HTML default used for listings and fichas
  }
  return HTML_ACCEPT;
}

async function readViaRelay(url: string, relay: FetchRelayTarget, signal: AbortSignal): Promise<string> {
  const origin = requestOrigin(url);
  const headers: Record<string, string> = {
    accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    authorization: `Bearer ${relay.token}`,
  };
  const cookie = origin ? originCookieJar.get(origin) : undefined;
  if (cookie) headers[RELAY_ORIGIN_COOKIE_HEADER] = cookie;
  const response = await fetch(relay.requestUrl, {
    signal,
    redirect: 'manual',
    headers,
  });
  rememberRelayCookies(origin, response);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HttpError(response.status, url, response.headers.get('retry-after'));
  }
  return await readDocumentBody(url, response);
}

async function readFollowingRedirects(url: string, signal: AbortSignal): Promise<string> {
  const cookiesByOrigin = new Map(originCookieJar);
  let current = url;
  try {
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const origin = requestOrigin(current);
      if (!origin) throw new Error(`URL no soportada: ${current}`);
      const headers: Record<string, string> = {
        accept: acceptHeaderForUrl(current),
        'user-agent': USER_AGENT,
      };
      const cookie = cookiesByOrigin.get(origin);
      if (cookie) headers.cookie = cookie;
      const response = await fetch(current, { signal, redirect: 'manual', headers });
      rememberCookies(origin, response, cookiesByOrigin);
      if (response.status >= 300 && response.status < 400) {
        const retryAfter = response.headers.get('retry-after');
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location ? resolveRedirect(current, location) : undefined;
        if (!next) throw new HttpError(response.status, url, retryAfter);
        current = next;
        continue;
      }
      if (response.status >= 300) {
        await response.body?.cancel();
        throw new HttpError(response.status, url, response.headers.get('retry-after'));
      }
      return await readDocumentBody(url, response);
    }
    throw new Error(`demasiadas redirecciones al pedir ${url}`);
  } finally {
    for (const [origin, cookie] of cookiesByOrigin) originCookieJar.set(origin, cookie);
  }
}

/**
 * 202 is not a document (SiteGround captcha interstitial). 200 + sgcaptcha HTML
 * is the same challenge when a relay has already remapped the origin status.
 */
async function readDocumentBody(url: string, response: Response): Promise<string> {
  if (response.status === 202 || !response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status, url, response.headers.get('retry-after'));
  }
  const body = await response.text();
  if (isSiteGroundChallenge(body)) {
    throw new HttpError(202, url, response.headers.get('retry-after'));
  }
  return body;
}

function rememberRelayCookies(origin: string | undefined, response: Response): void {
  if (!origin) return;
  const returned = response.headers.get(RELAY_ORIGIN_COOKIE_HEADER);
  if (returned) originCookieJar.set(origin, returned);
}

function parseHttpUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function requestOrigin(url: string): string | undefined {
  return parseHttpUrl(url)?.origin;
}

function resolveRedirect(current: string, location: string): string | undefined {
  try {
    const next = new URL(location, current);
    return next.protocol === 'http:' || next.protocol === 'https:' ? next.href : undefined;
  } catch {
    return undefined;
  }
}

function rememberCookies(origin: string, response: Response, jar: Map<string, string>): void {
  const parsed = new Map<string, string>();
  const existing = jar.get(origin);
  if (existing) {
    for (const part of existing.split('; ')) {
      const index = part.indexOf('=');
      if (index > 0) parsed.set(part.slice(0, index), part.slice(index + 1));
    }
  }
  for (const raw of setCookieValues(response)) {
    const pair = raw.split(';', 1)[0]?.trim() ?? '';
    const index = pair.indexOf('=');
    if (index > 0) parsed.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (parsed.size) jar.set(origin, [...parsed].map(([name, value]) => `${name}=${value}`).join('; '));
}

function setCookieValues(response: Response): string[] {
  if (typeof response.headers.getSetCookie === 'function') {
    const all = response.headers.getSetCookie();
    if (all.length) return all;
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}
