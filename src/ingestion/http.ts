const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';

/** Preserve HTTP facts for source-local retry policies; no retries by default. */
export class HttpError extends Error {
  constructor(public readonly status: number, url: string, public readonly retryAfter: string | null = null) {
    super(`HTTP ${status} al pedir ${url}`);
  }
}

export async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, url, response.headers.get('retry-after'));
    }
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`tiempo agotado al pedir ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
