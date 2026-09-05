/** Conservative listing-only retry. Must not import `http.ts` (http → registry → adapters). */

export const LISTING_RETRY_DELAY_MS = 750;
export const LISTING_TRANSIENT_STATUSES = new Set([202, 408, 429, 500, 502, 503, 504]);
/** Transport fallback (direct → relay) also treats 403 as recoverable. Listing retries do not. */
export const RECOVERABLE_TRANSPORT_STATUSES = new Set([202, 403, 408, 429, 500, 502, 503, 504]);

export type ListingAttempt = {
  surface: string;
  transport?: 'direct' | 'relay';
  status?: number;
  message: string;
};

/** Visible multi-surface / multi-transport failure. Never includes cookies or tokens. */
export class ListingAttemptsError extends Error {
  readonly status?: number;
  constructor(
    sourceId: string,
    public readonly attempts: readonly ListingAttempt[],
  ) {
    super(`${sourceId}: ${attempts.map(formatListingAttempt).join('; ')}`);
    this.name = 'ListingAttemptsError';
    this.status = [...attempts].reverse().find((item) => item.status !== undefined)?.status;
  }
}

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

export function isRecoverableTransportError(error: unknown): boolean {
  const status = httpStatus(error);
  if (status !== undefined && RECOVERABLE_TRANSPORT_STATUSES.has(status)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /tiempo agotado|fetch failed/i.test(message);
}

export function listingAttemptsFromError(surface: string, error: unknown): ListingAttempt[] {
  if (error instanceof ListingAttemptsError) return [...error.attempts];
  const nested = nestedTransportAttempts(error);
  if (nested) {
    return nested.map((item) => ({
      surface,
      ...(item.transport ? { transport: item.transport } : {}),
      ...(typeof item.status === 'number' ? { status: item.status } : {}),
      message: item.message,
    }));
  }
  return [{
    surface,
    ...(httpStatus(error) !== undefined ? { status: httpStatus(error) } : {}),
    message: error instanceof Error ? error.message : String(error),
  }];
}

function formatListingAttempt(attempt: ListingAttempt): string {
  const via = attempt.transport ? ` ${attempt.transport}` : '';
  if (attempt.status !== undefined) return `${attempt.surface}${via} → HTTP ${attempt.status}`;
  return `${attempt.surface}${via} → ${attempt.message}`;
}

function nestedTransportAttempts(error: unknown): Array<{ transport?: 'direct' | 'relay'; status?: number; message: string }> | undefined {
  if (!error || typeof error !== 'object' || !('attempts' in error) || !Array.isArray(error.attempts)) return undefined;
  const items = error.attempts as unknown[];
  if (items.length === 0) return undefined;
  const parsed: Array<{ transport?: 'direct' | 'relay'; status?: number; message: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return undefined;
    const record = item as { transport?: unknown; status?: unknown; message?: unknown };
    const transport = record.transport === 'direct' || record.transport === 'relay' ? record.transport : undefined;
    const status = typeof record.status === 'number' ? record.status : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    if (!transport && status === undefined && !message) return undefined;
    parsed.push({
      ...(transport ? { transport } : {}),
      ...(status !== undefined ? { status } : {}),
      message: message ?? (status !== undefined ? `HTTP ${status}` : 'error'),
    });
  }
  return parsed;
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
