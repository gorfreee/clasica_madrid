import { isSiteGroundChallenge } from './listing-retry.ts';

export const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;

export type BrowserFetchAttempt = {
  url: string;
  durationMs: number;
  retry: boolean;
  browserFallback?: boolean;
  status?: number;
  timeout?: boolean;
  challenge?: boolean;
};

export type BrowserGetOptions = {
  waitForSelector: string;
  timeoutMs?: number;
};

export type BrowserDocumentSession = {
  get(url: string, options: BrowserGetOptions): Promise<string>;
  close(): Promise<void>;
};

type IngestBrowserPage = {
  goto(
    url: string,
    options?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number },
  ): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: 'attached' | 'visible' }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
};

type IngestBrowserContext = {
  newPage(): Promise<IngestBrowserPage>;
  close(): Promise<void>;
};

export type IngestBrowser = {
  newContext(): Promise<IngestBrowserContext>;
  close(): Promise<void>;
};

export type LaunchIngestBrowser = () => Promise<IngestBrowser>;

const recordedAttempts = new Map<string, BrowserFetchAttempt[]>();
let launchBrowser: LaunchIngestBrowser = launchSystemChrome;

/** Drain browser hops for one source. Never includes cookies or page bodies. */
export function takeBrowserFetchAttempts(sourceId: string): BrowserFetchAttempt[] {
  const attempts = recordedAttempts.get(sourceId) ?? [];
  recordedAttempts.delete(sourceId);
  return attempts;
}

/** Wrap a session so listing hops are attributable to one source. */
export function recordedBrowserSession(
  session: BrowserDocumentSession,
  sourceId: string,
): BrowserDocumentSession {
  let firstGet = true;
  return {
    async get(url, options) {
      const startedAtMs = performance.now();
      const fallback = firstGet;
      firstGet = false;
      try {
        const html = await session.get(url, options);
        recordAttempt(sourceId, { url, startedAtMs, fallback, status: 200 });
        return html;
      } catch (error) {
        recordAttempt(sourceId, { url, startedAtMs, fallback, error });
        throw error;
      }
    },
    close: () => session.close(),
  };
}

export function setBrowserLaunchForTests(launch?: LaunchIngestBrowser): void {
  launchBrowser = launch ?? launchSystemChrome;
}

export async function openBrowserSession(): Promise<BrowserDocumentSession> {
  let browser: IngestBrowser | undefined;
  let context: IngestBrowserContext | undefined;
  let page: IngestBrowserPage | undefined;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await context?.close();
    } finally {
      await browser?.close();
    }
  };

  try {
    browser = await launchBrowser();
    context = await browser.newContext();
    page = await context.newPage();
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    async get(url, options) {
      if (closed || !page) throw new Error('sesión de navegador cerrada');
      const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
      return await navigateAndWait(page, url, options.waitForSelector, timeoutMs);
    },
    close,
  };
}

async function launchSystemChrome(): Promise<IngestBrowser> {
  try {
    const { chromium } = await import('playwright-core');
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Chrome del sistema no disponible para el fallback del navegador (${detail})`);
  }
}

async function navigateAndWait(
  page: IngestBrowserPage,
  url: string,
  selector: string,
  timeoutMs: number,
): Promise<string> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (error) {
    if (isPlaywrightTimeout(error)) {
      throw new Error(`tiempo agotado al pedir ${url} con el navegador`);
    }
    throw error;
  }

  const current = page.url();
  if (isCaptchaUrl(current)) {
    throw challengeError('el navegador permaneció en el desafío SiteGround (captcha)');
  }

  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: 'attached' });
  } catch (error) {
    const html = await page.content().catch(() => '');
    if (isCaptchaUrl(page.url()) || isSiteGroundChallenge(html) || isInteractiveCaptcha(html)) {
      throw challengeError('se recibió una pantalla de desafío SiteGround (captcha) en el navegador');
    }
    if (isPlaywrightTimeout(error)) {
      throw new Error(`tiempo agotado esperando ${selector} en ${url}`);
    }
    throw error;
  }

  const html = await page.content();
  if (isCaptchaUrl(page.url()) || isSiteGroundChallenge(html) || isInteractiveCaptcha(html)) {
    throw challengeError('se recibió HTML de desafío SiteGround (captcha) en el navegador');
  }
  return html;
}

function isCaptchaUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().includes('/.well-known/sgcaptcha/');
  } catch {
    return /\/\.well-known\/sgcaptcha\//i.test(url);
  }
}

function isInteractiveCaptcha(html: string): boolean {
  return /<iframe\b[^>]*sgcaptcha/i.test(html) || /\bverify you are human\b/i.test(html);
}

function challengeError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 202 });
}

function isPlaywrightTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(message);
}

function recordAttempt(sourceId: string, input: {
  url: string;
  startedAtMs: number;
  fallback: boolean;
  status?: number;
  error?: unknown;
}): void {
  const failure = input.error ? classifyBrowserFailure(input.error) : undefined;
  const attempts = recordedAttempts.get(sourceId) ?? [];
  attempts.push({
    url: input.url,
    durationMs: Math.max(0, performance.now() - input.startedAtMs),
    retry: false,
    ...(input.fallback ? { browserFallback: true } : {}),
    ...(input.error ? failure : { status: input.status ?? 200 }),
  });
  recordedAttempts.set(sourceId, attempts);
}

function classifyBrowserFailure(error: unknown): {
  status?: number;
  timeout?: boolean;
  challenge?: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(/tiempo agotado/i.test(message) ? { timeout: true } : {}),
    ...(status === 202 || /sgcaptcha|SiteGround \(captcha\)|desafío/i.test(message) ? { challenge: true } : {}),
  };
}
