const USER_AGENT = 'ClasicaMadrid-ingestion/1 (+https://github.com/gorfreee/clasica_madrid)';

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
      throw new Error(`HTTP ${response.status} al pedir ${url}`);
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
