import { performance } from 'node:perf_hooks';
import { isRecoverableTransportError, isSiteGroundChallenge } from './listing-retry.ts';
import { fetchRelayHosts, fetchTransportForHost } from './registry.ts';

const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const MAX_REDIRECTS = 10;
export const RELAY_ORIGIN_COOKIE_HEADER = 'x-relay-origin-cookie';
export const RELAY_RECOVERIES_HEADER = 'x-relay-recoveries';
/** HTML listings and fichas. SiteGround treats this as a browser and may 202 a `/wp-json/` URL. */
export const HTML_ACCEPT = 'text/html,application/json;q=0.9,*/*;q=0.8';
/**
 * WordPress REST. SiteGround 202s HTML captcha when Accept includes text/html
 * or a wildcard type; JSON-only plus the ingestion User-Agent returns the CPT JSON.
 */
export const JSON_DOCUMENT_ACCEPT = 'application/json';

/** Same-origin cookies kept for the process, including across relay hops. */
const originCookieJar = new Map<string, string>();
/** Last Worker challenge recoveries, keyed by the official URL just fetched. */
const relayRecoveriesByUrl = new Map<string, number>();
/** Actual HTTP hops performed by the last `getText` call, drained by observability. */
const recordedHttpAttempts: RecordedHttpAttempt[] = [];

export type RecordedHttpAttempt = {
  url: string;
  transport: 'direct' | 'relay';
  durationMs: number;
  retry: boolean;
  status?: number;
  timeout?: boolean;
  fetchFailed?: boolean;
  challenge?: boolean;
  recoveries?: number;
};

export type TransportAttempt = {
  transport: 'direct' | 'relay';
  status?: number;
  message: string;
};

/** Both transports of `direct-then-relay` failed. Never includes cookies or tokens. */
export class TransportAttemptsError extends Error {
  readonly status?: number;
  constructor(
    url: string,
    public readonly attempts: readonly TransportAttempt[],
  ) {
    const detail = attempts.map((item) => (
      item.status !== undefined ? `${item.transport} → HTTP ${item.status}` : `${item.transport} → ${item.message}`
    )).join('; ');
    super(`${attempts.at(-1)?.message ?? `error al pedir ${url}`} [${detail}]`);
    this.name = 'TransportAttemptsError';
    this.status = [...attempts].reverse().find((item) => item.status !== undefined)?.status;
  }
}

export function resetOriginCookieJar(): void {
  originCookieJar.clear();
  relayRecoveriesByUrl.clear();
  recordedHttpAttempts.length = 0;
}

export function takeRecordedHttpAttempts(url?: string): RecordedHttpAttempt[] {
  if (!url) return recordedHttpAttempts.splice(0, recordedHttpAttempts.length);
  const taken: RecordedHttpAttempt[] = [];
  for (let i = 0; i < recordedHttpAttempts.length; ) {
    if (recordedHttpAttempts[i]!.url === url) {
      taken.push(recordedHttpAttempts.splice(i, 1)[0]!);
    } else {
      i += 1;
    }
  }
  return taken;
}

/** Consume recoveries recorded for this official URL; never logs cookie values. */
export function takeRelayRecoveries(url: string): number {
  const count = relayRecoveriesByUrl.get(url) ?? 0;
  relayRecoveriesByUrl.delete(url);
  return count;
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
 * Worker only when URL and token are both set. Hosts marked
 * `direct-then-relay` try the origin first and use the Worker only after a
 * recoverable block (202/403/408/429/5xx/timeout/fetch-failed). Callers keep
 * passing the official source URL; this function never rewrites it into a
 * workers.dev address. Error statuses are never retried on relay-only hosts,
 * and a 403 on a direct-only host is never sent to the relay.
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
  if (transportStrategy(url) === 'direct-then-relay') {
    return await readDirectThenRelay(url, timeoutMs, env);
  }
  return await readOnce(url, timeoutMs, env);
}

function transportStrategy(url: string): 'direct' | 'relay' | 'direct-then-relay' {
  const parsed = parseHttpUrl(url);
  return parsed ? fetchTransportForHost(parsed.hostname) : 'direct';
}

async function readOnce(url: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  const startedAtMs = performance.now();
  let transport: 'direct' | 'relay' = 'direct';
  try {
    if (resolveFetchRelay(url, env)) transport = 'relay';
  } catch {
    transport = 'relay';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const relay = resolveFetchRelay(url, env);
    const body = relay
      ? await readViaRelay(url, relay, controller.signal)
      : await readFollowingRedirects(url, controller.signal);
    recordAttempt({ url, transport, startedAtMs, retry: false });
    return body;
  } catch (error) {
    const wrapped = wrapAbort(url, error);
    recordAttempt({ url, transport, startedAtMs, retry: false, error: wrapped });
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function readDirectThenRelay(url: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  const directStartedAtMs = performance.now();
  try {
    const body = await withTimeout(timeoutMs, (signal) => readFollowingRedirects(url, signal));
    recordAttempt({ url, transport: 'direct', startedAtMs: directStartedAtMs, retry: false });
    return body;
  } catch (error) {
    const directError = wrapAbort(url, error);
    recordAttempt({ url, transport: 'direct', startedAtMs: directStartedAtMs, retry: false, error: directError });
    if (!isRecoverableTransportError(directError)) throw directError;

    let relay: FetchRelayTarget | undefined;
    try {
      relay = resolveFetchRelay(url, env);
    } catch (configError) {
      throw new TransportAttemptsError(url, [
        toTransportAttempt('direct', directError),
        toTransportAttempt('relay', configError),
      ]);
    }
    if (!relay) throw directError;

    const target = relay;
    const relayStartedAtMs = performance.now();
    try {
      const body = await withTimeout(timeoutMs, (signal) => readViaRelay(url, target, signal));
      recordAttempt({ url, transport: 'relay', startedAtMs: relayStartedAtMs, retry: true });
      return body;
    } catch (relayError) {
      const wrapped = wrapAbort(url, relayError);
      recordAttempt({ url, transport: 'relay', startedAtMs: relayStartedAtMs, retry: true, error: wrapped });
      throw new TransportAttemptsError(url, [
        toTransportAttempt('direct', directError),
        toTransportAttempt('relay', wrapped),
      ]);
    }
  }
}

async function withTimeout<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function wrapAbort(url: string, error: unknown): unknown {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`tiempo agotado al pedir ${url}`);
  }
  return error;
}

function recordAttempt(input: {
  url: string;
  transport: 'direct' | 'relay';
  startedAtMs: number;
  retry: boolean;
  error?: unknown;
}): void {
  const failure = input.error ? classifyTransportFailure(input.error) : undefined;
  recordedHttpAttempts.push({
    url: input.url,
    transport: input.transport,
    durationMs: Math.max(0, performance.now() - input.startedAtMs),
    retry: input.retry,
    recoveries: takeRelayRecoveries(input.url),
    ...(input.error ? failure : { status: 200 }),
  });
}

function classifyTransportFailure(error: unknown): {
  status?: number;
  timeout?: boolean;
  fetchFailed?: boolean;
  challenge?: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = errorStatus(error);
  const timeout = /tiempo agotado/i.test(message);
  const fetchFailed = /fetch failed/i.test(message);
  const challenge = status === 202 || /sgcaptcha|SiteGround \(captcha\)|HTML de desafío/i.test(message);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(timeout ? { timeout: true } : {}),
    ...(fetchFailed ? { fetchFailed: true } : {}),
    ...(challenge ? { challenge: true } : {}),
  };
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function toTransportAttempt(transport: 'direct' | 'relay', error: unknown): TransportAttempt {
  const status = errorStatus(error);
  return {
    transport,
    ...(status !== undefined ? { status } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
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
  rememberRelayRecoveries(url, response);
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

function rememberRelayRecoveries(url: string, response: Response): void {
  const raw = response.headers.get(RELAY_RECOVERIES_HEADER);
  if (!raw) return;
  const count = Number(raw);
  if (Number.isSafeInteger(count) && count > 0) relayRecoveriesByUrl.set(url, count);
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
