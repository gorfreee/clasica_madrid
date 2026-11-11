import { stripTags } from './html.ts';
import { isSiteGroundChallenge } from './listing-retry.ts';

export const DEFAULT_BROWSER_TIMEOUT_MS = 45_000;
const DOCUMENT_SAMPLE_MAX_CHARS = 320;
const DOCUMENT_TITLE_MAX_CHARS = 160;
const DOCUMENT_URL_MAX_CHARS = 500;

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
    const diagnosis = diagnoseBrowserDocument(page, html, url);
    const challenge = detectBrowserChallenge(html, diagnosis.finalUrl);
    if (challenge) throw challengeError(formatChallengeDiagnosis(challenge, diagnosis));
    const prefix = isPlaywrightTimeout(error)
      ? `browser: tiempo agotado; selector ${JSON.stringify(selector)} ausente`
      : `browser: fallo esperando selector ${JSON.stringify(selector)}`;
    throw new Error(`${prefix}; ${formatDocumentDiagnosis(diagnosis, true)}`);
  }

  const html = await page.content();
  const finalUrl = currentDiagnosticUrl(page, url);
  const challenge = detectBrowserChallenge(html, finalUrl);
  if (challenge) {
    throw challengeError(formatChallengeDiagnosis(
      challenge,
      diagnoseBrowserDocument(page, html, url),
    ));
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

type BrowserChallenge = {
  provider: 'SiteGround' | 'Cloudflare' | 'interactivo';
  markers: string[];
};

type BrowserDocumentDiagnosis = {
  finalUrl: string;
  title: string;
  htmlChars: number;
  sample: string;
};

function detectBrowserChallenge(html: string, finalUrl: string): BrowserChallenge | undefined {
  const siteGroundMarkers: string[] = [];
  if (isCaptchaUrl(finalUrl)) siteGroundMarkers.push('sgcaptcha-url');
  if (isSiteGroundChallenge(html)) siteGroundMarkers.push('sgcaptcha-html');
  if (/<iframe\b[^>]*sgcaptcha/i.test(html)) siteGroundMarkers.push('sgcaptcha-iframe');
  if (siteGroundMarkers.length > 0) {
    return { provider: 'SiteGround', markers: siteGroundMarkers };
  }

  const cloudflare = detectCloudflareChallenge(html);
  if (cloudflare.length > 0) return { provider: 'Cloudflare', markers: cloudflare };

  if (/\bverify(?:ing)? you are human\b/i.test(html)) {
    return { provider: 'interactivo', markers: ['verify-human'] };
  }
  return undefined;
}

/** Require corroborating Cloudflare challenge signals, not just the vendor name. */
function detectCloudflareChallenge(html: string): string[] {
  const title = documentTitle(html);
  const markers: string[] = [];
  const contentMarkers: string[] = [];
  const infrastructureMarkers: string[] = [];

  if (/^just a moment(?:\.{3}|…)?$/i.test(title)) contentMarkers.push('title:just-a-moment');
  if (/attention required!\s*\|\s*cloudflare/i.test(title)) contentMarkers.push('title:attention-required');
  if (/\bchecking your browser\b/i.test(html)) contentMarkers.push('checking-browser');
  if (/\benable javascript and cookies to continue\b/i.test(html)) contentMarkers.push('enable-js-cookies');
  if (/\bplease enable javascript and cookies to continue\b/i.test(html)) contentMarkers.push('please-enable-js-cookies');

  if (/\bcf-chl-[a-z0-9_-]*/i.test(html)) infrastructureMarkers.push('cf-chl');
  if (/\/cdn-cgi\/challenge-platform\//i.test(html)) infrastructureMarkers.push('challenge-platform');
  if (/\bchallenges\.cloudflare\.com\b/i.test(html)) infrastructureMarkers.push('challenges.cloudflare.com');
  if (/\bcf-turnstile\b/i.test(html)) infrastructureMarkers.push('cf-turnstile');

  markers.push(...contentMarkers, ...infrastructureMarkers);
  const decisiveTitle = contentMarkers.includes('title:attention-required');
  if (decisiveTitle || (contentMarkers.length > 0 && infrastructureMarkers.length > 0)) {
    return markers;
  }
  return [];
}

function diagnoseBrowserDocument(
  page: IngestBrowserPage,
  html: string,
  requestedUrl: string,
): BrowserDocumentDiagnosis {
  return {
    finalUrl: currentDiagnosticUrl(page, requestedUrl),
    title: limitedText(documentTitle(html), DOCUMENT_TITLE_MAX_CHARS),
    htmlChars: html.length,
    sample: documentTextSample(html),
  };
}

function currentDiagnosticUrl(page: IngestBrowserPage, requestedUrl: string): string {
  let finalUrl = requestedUrl;
  try {
    finalUrl = page.url() || requestedUrl;
  } catch {
    // Keep the requested URL when Playwright cannot report the current page.
  }
  return safeDiagnosticUrl(finalUrl);
}

function documentTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? stripTags(match[1]) : '';
}

function documentTextSample(html: string): string {
  const safeHtml = html
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(?:script|style|template|svg|noscript|form)\b[^>]*>[\s\S]*?<\/(?:script|style|template|svg|noscript|form)>/gi, ' ')
    .replace(/<(?:input|textarea|select|button)\b[^>]*>[\s\S]*?<\/(?:textarea|select|button)>/gi, ' ')
    .replace(/<(?:input|textarea|select|button)\b[^>]*\/?>/gi, ' ');
  const text = stripTags(safeHtml)
    .replace(/\b(token|api[_ -]?key|authorization|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return limitedText(text, DOCUMENT_SAMPLE_MAX_CHARS);
}

function limitedText(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function safeDiagnosticUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return limitedText(parsed.toString(), DOCUMENT_URL_MAX_CHARS);
  } catch {
    return limitedText(value.split(/[?#]/, 1)[0] ?? '', DOCUMENT_URL_MAX_CHARS);
  }
}

function formatChallengeDiagnosis(
  challenge: BrowserChallenge,
  diagnosis: BrowserDocumentDiagnosis,
): string {
  return `browser: challenge ${challenge.provider} detectado; ${formatDocumentDiagnosis(diagnosis, false)}; markers=${challenge.markers.join(',')}`;
}

function formatDocumentDiagnosis(diagnosis: BrowserDocumentDiagnosis, includeSample: boolean): string {
  const fields = [
    `finalUrl=${diagnosis.finalUrl}`,
    `title=${JSON.stringify(diagnosis.title)}`,
    `htmlChars=${diagnosis.htmlChars}`,
  ];
  if (includeSample && diagnosis.sample) fields.push(`sample=${JSON.stringify(diagnosis.sample)}`);
  return fields.join('; ');
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
