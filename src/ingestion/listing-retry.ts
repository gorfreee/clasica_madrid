/** Conservative listing-only retry. Must not import `http.ts` (http → registry → adapters). */

export const LISTING_RETRY_DELAY_MS = 750;
export const LISTING_TRANSIENT_STATUSES = new Set([202, 408, 429, 500, 502, 503, 504]);

export function isSiteGroundChallenge(body: string): boolean {
  return /\/\.well-known\/sgcaptcha\/|\bsgcaptcha\b/i.test(body);
}

/** JSON listings must not treat a captcha/error page as a parseable document. */
export function unexpectedHtmlInsteadOfJson(sourceId: string, body: string): string | undefined {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('<')) return undefined;
  if (isSiteGroundChallenge(body)) {
    return `${sourceId}: se recibió HTML de desafío SiteGround (captcha) en lugar de JSON`;
  }
  return `${sourceId}: se recibió HTML inesperado en lugar de JSON`;
}

export function isTransientListingError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== undefined && LISTING_TRANSIENT_STATUSES.has(status)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /tiempo agotado|fetch failed|sgcaptcha|SiteGround \(captcha\)|HTML de desafío/i.test(message);
}

export function createListingGet(
  get: (url: string) => Promise<string>,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    delayMs?: number;
  },
): (url: string) => Promise<string> {
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delayMs = options?.delayMs ?? LISTING_RETRY_DELAY_MS;
  return async (url: string): Promise<string> => {
    try {
      return await get(url);
    } catch (error) {
      if (!isTransientListingError(error)) throw error;
      if (delayMs > 0) await sleep(delayMs);
      return await get(url);
    }
  };
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}
