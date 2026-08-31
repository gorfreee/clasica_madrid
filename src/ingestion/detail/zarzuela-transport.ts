/** Shared Zarzuela HTTP pacing. This module must not import `http.ts` or the registry. */

export const ZARZUELA_GAP_MS = 1_500;
export const ZARZUELA_MAX_RETRY_WAIT_MS = 60_000;
export const ZARZUELA_RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);

export function zarzuelaRetryAfterMs(value: string | null | undefined): number {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function httpRetryAfter(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('retryAfter' in error)) return null;
  const value = error.retryAfter;
  return typeof value === 'string' || value === null ? value : null;
}

/**
 * Listing pages share the same origin as fichas. Pace them and allow one
 * retry so a transient Imperva 403/503 does not fail the whole source.
 * Persistent failure still throws: a missing category is incomplete coverage.
 */
export function createZarzuelaListingGet(get: (url: string) => Promise<string>) {
  let nextRequestAt = 0;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  return async (url: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wait = nextRequestAt - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const body = await get(url);
        nextRequestAt = Date.now() + ZARZUELA_GAP_MS;
        return body;
      } catch (error) {
        nextRequestAt = Date.now() + ZARZUELA_GAP_MS;
        lastError = error;
        const status = httpStatus(error);
        const retryAfter = zarzuelaRetryAfterMs(httpRetryAfter(error));
        if (
          retryAfter > ZARZUELA_MAX_RETRY_WAIT_MS ||
          status === undefined ||
          !ZARZUELA_RETRYABLE.has(status) ||
          attempt === 1
        ) {
          throw error;
        }
        const backoff = 2_000 + Math.floor(Math.random() * 500);
        nextRequestAt = Date.now() + Math.max(backoff, retryAfter, ZARZUELA_GAP_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
