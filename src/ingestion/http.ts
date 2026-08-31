const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const MAX_REDIRECTS = 10;

/** Hosts that may use INGEST_FETCH_RELAY_URL. Ordinary hosts never do. */
export const FETCH_RELAY_HOSTS = ['www.march.es'] as const;

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
 * Direct cookie-aware fetch, or a configured fetch relay for allowlisted hosts.
 *
 * Ordinary URLs always use the current direct transport. `www.march.es` uses
 * the relay only when URL and token are both set. Callers keep passing the
 * official source URL; this function never rewrites it into a workers.dev
 * address. Error statuses are never retried.
 *
 * Native fetch does not persist Set-Cookie across redirects. www.march.es
 * answers a same-URL 307 with a session cookie; the direct client follows
 * redirects itself and sends cookies only back to the origin that set them.
 * The relay Worker does the same cookie replay behind the allowlist.
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
 * `undefined` → direct transport. Throws if this host is allowlisted but the
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
  return (FETCH_RELAY_HOSTS as readonly string[]).includes(hostname);
}

async function readViaRelay(url: string, relay: FetchRelayTarget, signal: AbortSignal): Promise<string> {
  const response = await fetch(relay.requestUrl, {
    signal,
    redirect: 'manual',
    headers: {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      authorization: `Bearer ${relay.token}`,
    },
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HttpError(response.status, url, response.headers.get('retry-after'));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status, url, response.headers.get('retry-after'));
  }
  return await response.text();
}

async function readFollowingRedirects(url: string, signal: AbortSignal): Promise<string> {
  const cookiesByOrigin = new Map<string, string>();
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const origin = requestOrigin(current);
    if (!origin) throw new Error(`URL no soportada: ${current}`);
    const headers: Record<string, string> = {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
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
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, url, response.headers.get('retry-after'));
    }
    return await response.text();
  }
  throw new Error(`demasiadas redirecciones al pedir ${url}`);
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
