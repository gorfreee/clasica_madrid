const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const MAX_REDIRECTS = 10;

/** Preserve HTTP facts for source-local retry policies; no retries by default. */
export class HttpError extends Error {
  constructor(public readonly status: number, url: string, public readonly retryAfter: string | null = null) {
    super(`HTTP ${status} al pedir ${url}`);
  }
}

/**
 * Native fetch does not persist Set-Cookie across redirects. www.march.es
 * answers a same-URL 307 with a session cookie; following without it yields
 * 403 (GitHub Actions) or a closed connection (some networks). This client
 * follows redirects itself and sends cookies only back to the origin that
 * set them. Error statuses are never retried.
 */
export async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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

function requestOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
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
