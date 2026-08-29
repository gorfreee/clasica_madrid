export function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return value.trim();
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.href;
}

export function resolveUrl(href: string, base: string): string {
  return new URL(href, base).href;
}

export function urlPathIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last ?? parsed.pathname;
  } catch {
    return url;
  }
}
