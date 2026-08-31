/**
 * Minimal GET-only fetch relay for GitHub-hosted ingestion.
 * Not an open proxy: Bearer token + host/path allowlist + same-origin redirects.
 *
 * Allowed targets (keep in sync with src/ingestion/http.ts FETCH_RELAY_HOSTS
 * and the March adapter URLs):
 *   https://www.march.es/es/madrid/conciertos
 *   https://www.march.es/es/madrid/concierto/*
 *
 * Deploy: see README.md. Secret: INGEST_FETCH_RELAY_TOKEN.
 */

const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';
const MAX_REDIRECTS = 5;
const ALLOWED_HOST = 'www.march.es';

export default {
  async fetch(request, env) {
    return handleRelayRequest(request, env);
  },
};

export async function handleRelayRequest(request, env) {
  if (request.method !== 'GET') {
    return errorResponse(405, 'method not allowed');
  }
  if (!bearerOk(request, env)) {
    return errorResponse(401, 'unauthorized');
  }
  const targetParam = new URL(request.url).searchParams.get('url');
  const target = allowedTarget(targetParam);
  if (!target) {
    return errorResponse(403, 'forbidden target');
  }
  try {
    const html = await fetchOrigin(target);
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof OriginHttpError) {
      return errorResponse(error.status, `origin HTTP ${error.status}`);
    }
    const message = error instanceof Error ? error.message : 'origin fetch failed';
    if (message === 'redirect not allowed' || message === 'too many redirects') {
      return errorResponse(502, message);
    }
    return errorResponse(502, 'origin fetch failed');
  }
}

class OriginHttpError extends Error {
  constructor(status) {
    super(`origin HTTP ${status}`);
    this.status = status;
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

function allowedTarget(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (url.hostname !== ALLOWED_HOST || url.search || url.hash) return undefined;
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/es/madrid/conciertos') return url;
  if (/^\/es\/madrid\/concierto\/[^/]+$/.test(path)) return url;
  return undefined;
}

async function fetchOrigin(initial) {
  const cookiesByOrigin = new Map();
  let current = initial.href;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const origin = new URL(current).origin;
    const headers = {
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'user-agent': USER_AGENT,
    };
    const cookie = cookiesByOrigin.get(origin);
    if (cookie) headers.cookie = cookie;
    const response = await fetch(current, { redirect: 'manual', headers });
    rememberCookies(origin, response, cookiesByOrigin);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      const next = location ? resolveSameOriginRedirect(current, location) : undefined;
      if (!next) throw new Error('redirect not allowed');
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OriginHttpError(response.status);
    }
    return await response.text();
  }
  throw new Error('too many redirects');
}

function resolveSameOriginRedirect(current, location) {
  let next;
  try {
    next = new URL(location, current);
  } catch {
    return undefined;
  }
  if (next.origin !== new URL(current).origin) return undefined;
  return allowedTarget(next.href)?.href;
}

function rememberCookies(origin, response, jar) {
  const parsed = new Map();
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

function setCookieValues(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    const all = response.headers.getSetCookie();
    if (all.length) return all;
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
