/**
 * Authenticated GET-only fetch relay for GitHub-hosted ingestion.
 * Not an open proxy: Bearer token + public HTTPS targets only.
 *
 * Which hosts the pipeline sends here is decided in the source registry
 * (`useFetchRelay`). This Worker has no source/host allowlist.
 *
 * Deploy: see README.md. Secret: INGEST_FETCH_RELAY_TOKEN.
 */

const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const HTML_ACCEPT = 'text/html,application/json;q=0.9,*/*;q=0.8';
const JSON_DOCUMENT_ACCEPT = 'application/json';
const MAX_REDIRECTS = 5;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.invalid', '.arpa'];
const RELAY_COOKIE_HEADER = 'x-relay-origin-cookie';
const MAX_RELAY_COOKIE_CHARS = 4096;
const COOKIE_CHALLENGE_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);

/** Isolate-scoped same-origin cookies. Sequential ingest hops often reuse it. */
const isolateCookies = new Map();

export default {
  async fetch(request, env) {
    return handleRelayRequest(request, env);
  },
};

export function resetRelayCookieJar() {
  isolateCookies.clear();
}

export async function handleRelayRequest(request, env) {
  if (request.method !== 'GET') {
    return errorResponse(405, 'method not allowed');
  }
  if (!bearerOk(request, env)) {
    return errorResponse(401, 'unauthorized');
  }
  const targetParam = new URL(request.url).searchParams.get('url');
  const target = publicHttpsTarget(targetParam);
  if (!target) {
    return errorResponse(403, 'forbidden target');
  }
  const inbound = parseRelayCookies(request.headers.get(RELAY_COOKIE_HEADER));
  try {
    const html = await fetchOrigin(target, inbound);
    return new Response(html, {
      status: 200,
      headers: relayResponseHeaders(isolateCookies.get(target.origin)),
    });
  } catch (error) {
    if (error instanceof OriginHttpError) {
      return errorResponse(error.status, `origin HTTP ${error.status}`, error.cookies);
    }
    const message = error instanceof Error ? error.message : 'origin fetch failed';
    if (message === 'redirect not allowed' || message === 'too many redirects') {
      return errorResponse(502, message);
    }
    return errorResponse(502, 'origin fetch failed');
  }
}

class OriginHttpError extends Error {
  constructor(status, cookies) {
    super(`origin HTTP ${status}`);
    this.status = status;
    this.cookies = cookies;
  }
}

function bearerOk(request, env) {
  const expected = env?.INGEST_FETCH_RELAY_TOKEN?.trim() ?? '';
  const header = request.headers.get('authorization') ?? '';
  if (!expected || !header.startsWith('Bearer ') || header.length !== `Bearer ${expected}`.length) {
    return false;
  }
  const provided = header.slice('Bearer '.length);
  return timingSafeEqual(provided, expected);
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/** `/wp-json/` is JSON-only: SiteGround 202s if Accept includes HTML or a wildcard type. */
function originAccept(url) {
  try {
    if (new URL(url).pathname.toLowerCase().includes('/wp-json/')) return JSON_DOCUMENT_ACCEPT;
  } catch {
    // keep the HTML default
  }
  return HTML_ACCEPT;
}

function publicHttpsTarget(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost') return undefined;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  if (isIpLiteral(host)) return undefined;
  return url;
}

function isIpLiteral(host) {
  if (host.includes(':')) return true;
  if (/^[\d.]+$/.test(host)) return true;
  return false;
}

async function fetchOrigin(initial, inboundCookies) {
  const cookiesByOrigin = new Map();
  const startOrigin = initial.origin;
  const seeded = mergeCookieString(isolateCookies.get(startOrigin), inboundCookies);
  if (seeded) cookiesByOrigin.set(startOrigin, seeded);
  let current = initial.href;
  let cookieChallengeUsed = false;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const origin = new URL(current).origin;
    const headers = {
      accept: originAccept(current),
      'user-agent': USER_AGENT,
    };
    const cookie = cookiesByOrigin.get(origin);
    if (cookie) headers.cookie = cookie;
    const response = await fetch(current, { redirect: 'manual', headers });
    const before = cookiesByOrigin.get(origin);
    rememberCookies(origin, response, cookiesByOrigin);
    persistIsolateCookies(origin, cookiesByOrigin);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      const next = location ? resolveSameOriginRedirect(current, location) : undefined;
      if (!next) throw new Error('redirect not allowed');
      current = next;
      continue;
    }
    if (response.status === 202 || !response.ok) {
      const after = cookiesByOrigin.get(origin);
      const canChallenge =
        !cookieChallengeUsed &&
        COOKIE_CHALLENGE_STATUSES.has(response.status) &&
        Boolean(after) &&
        after !== before;
      await response.body?.cancel();
      if (canChallenge) {
        cookieChallengeUsed = true;
        continue;
      }
      throw new OriginHttpError(response.status, after);
    }
    persistIsolateCookies(origin, cookiesByOrigin);
    return await response.text();
  }
  throw new Error('too many redirects');
}

function persistIsolateCookies(origin, jar) {
  const cookie = jar.get(origin);
  if (cookie) isolateCookies.set(origin, cookie);
}

function resolveSameOriginRedirect(current, location) {
  let next;
  try {
    next = new URL(location, current);
  } catch {
    return undefined;
  }
  if (next.origin !== new URL(current).origin) return undefined;
  return publicHttpsTarget(next.href)?.href;
}

function rememberCookies(origin, response, jar) {
  const parsed = cookieMap(jar.get(origin));
  for (const raw of setCookieValues(response)) {
    const pair = raw.split(';', 1)[0]?.trim() ?? '';
    const index = pair.indexOf('=');
    if (index > 0) parsed.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (parsed.size) jar.set(origin, serializeCookieMap(parsed));
}

function cookieMap(value) {
  const parsed = new Map();
  if (!value) return parsed;
  for (const part of value.split('; ')) {
    const index = part.indexOf('=');
    if (index > 0) parsed.set(part.slice(0, index), part.slice(index + 1));
  }
  return parsed;
}

function serializeCookieMap(parsed) {
  return [...parsed].map(([name, value]) => `${name}=${value}`).join('; ');
}

function mergeCookieString(existing, inbound) {
  const parsed = cookieMap(existing);
  for (const [name, value] of cookieMap(inbound)) parsed.set(name, value);
  return parsed.size ? serializeCookieMap(parsed) : undefined;
}

function parseRelayCookies(value) {
  if (!value || value.length > MAX_RELAY_COOKIE_CHARS || /[\r\n]/.test(value)) return undefined;
  const parsed = new Map();
  for (const part of value.split('; ')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index);
    const cookieValue = part.slice(index + 1);
    if (!/^[A-Za-z0-9_!#$%&'*+\-.^`|~]+$/.test(name)) continue;
    if (!cookieValue || cookieValue.length > 1024 || /[;\r\n]/.test(cookieValue)) continue;
    parsed.set(name, cookieValue);
  }
  if (!parsed.size || parsed.size > 30) return undefined;
  return serializeCookieMap(parsed);
}

function setCookieValues(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    const all = response.headers.getSetCookie();
    if (all.length) return all;
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function relayResponseHeaders(cookies) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (cookies) headers[RELAY_COOKIE_HEADER] = cookies;
  return headers;
}

function errorResponse(status, message, cookies) {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (cookies) headers[RELAY_COOKIE_HEADER] = cookies;
  return new Response(message, { status, headers });
}
