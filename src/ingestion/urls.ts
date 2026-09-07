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
  return normalizeUrl(new URL(href, base).href);
}

export function urlPathIdentity(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url));
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last ?? parsed.pathname;
  } catch {
    return url;
  }
}

export function urlsEquivalent(left: string, right: string): boolean {
  if (normalizeUrl(left) === normalizeUrl(right)) return true;
  const leftId = madridVgnextoid(left);
  const rightId = madridVgnextoid(right);
  return Boolean(leftId && rightId && leftId === rightId);
}

/**
 * Madrid.es fichas share a CMS object id (`vgnextoid`) across portal SEO URLs
 * and the `sites/v/index.jsp` listing links. Channel (`vgnextchannel`) is
 * presentation, not identity.
 */
export function madridVgnextoid(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'madrid.es') return undefined;
    const id = url.searchParams.get('vgnextoid')?.trim();
    return id && /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
