import { afterEach, describe, expect, it } from 'vitest';
import {
  openBrowserSession,
  recordedBrowserSession,
  setBrowserLaunchForTests,
  takeBrowserFetchAttempts,
  type IngestBrowser,
} from '../src/ingestion/browser-fetch.ts';

const ARCHIVE = 'https://realhermandaddelrefugio.org/categoria-eventos/conciertos/';
const READY = '.jet-listing-grid__items[data-pages]';
const ARCHIVE_HTML = '<div class="jet-listing-grid__items" data-pages="1"></div>';
const CHALLENGE_HTML = '<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>';

afterEach(() => {
  setBrowserLaunchForTests();
  takeBrowserFetchAttempts('browser-fetch-test');
});

function fakeBrowser(options: {
  html?: string;
  stayOnUrl?: string;
  goto?: (url: string) => Promise<void>;
  waitForSelector?: () => Promise<void>;
  closed: { browser: boolean; context: boolean };
}): IngestBrowser {
  let currentUrl = options.stayOnUrl ?? 'about:blank';
  return {
    async newContext() {
      return {
        async newPage() {
          return {
            async goto(url) {
              currentUrl = options.stayOnUrl ?? url;
              if (options.goto) await options.goto(url);
            },
            async waitForSelector() {
              if (options.waitForSelector) await options.waitForSelector();
            },
            async content() {
              return options.html ?? ARCHIVE_HTML;
            },
            url() {
              return currentUrl;
            },
          };
        },
        async close() {
          options.closed.context = true;
        },
      };
    },
    async close() {
      options.closed.browser = true;
    },
  };
}

describe('browser-fetch', () => {
  it('devuelve el documento cuando el selector real está presente', async () => {
    const closed = { browser: false, context: false };
    setBrowserLaunchForTests(async () => fakeBrowser({ html: ARCHIVE_HTML, closed }));
    const session = recordedBrowserSession(await openBrowserSession(), 'browser-fetch-test');
    await expect(session.get(ARCHIVE, { waitForSelector: READY })).resolves.toContain('jet-listing-grid__items');
    await session.close();
    expect(closed.browser).toBe(true);
    expect(closed.context).toBe(true);
    const attempts = takeBrowserFetchAttempts('browser-fetch-test');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.browserFallback).toBe(true);
    expect(attempts[0]?.status).toBe(200);
  });

  it('falla si la URL permanece en sgcaptcha', async () => {
    const closed = { browser: false, context: false };
    setBrowserLaunchForTests(async () => fakeBrowser({
      stayOnUrl: 'https://realhermandaddelrefugio.org/.well-known/sgcaptcha/?r=%2F',
      html: CHALLENGE_HTML,
      closed,
    }));
    const session = recordedBrowserSession(await openBrowserSession(), 'browser-fetch-test');
    await expect(session.get(ARCHIVE, { waitForSelector: READY })).rejects.toMatchObject({ status: 202 });
    await session.close();
    expect(closed.browser).toBe(true);
    const attempts = takeBrowserFetchAttempts('browser-fetch-test');
    expect(attempts[0]?.challenge).toBe(true);
  });

  it('cierra browser y context aunque get falle', async () => {
    const closed = { browser: false, context: false };
    setBrowserLaunchForTests(async () => fakeBrowser({
      html: ARCHIVE_HTML,
      closed,
      async goto() {
        throw Object.assign(new Error('Timeout 45000ms exceeded'), { name: 'TimeoutError' });
      },
    }));
    const session = recordedBrowserSession(await openBrowserSession(), 'browser-fetch-test');
    await expect(session.get(ARCHIVE, { waitForSelector: READY })).rejects.toThrow(/tiempo agotado/);
    await session.close();
    expect(closed.context).toBe(true);
    expect(closed.browser).toBe(true);
    expect(takeBrowserFetchAttempts('browser-fetch-test')[0]?.timeout).toBe(true);
  });

  it('cierra el browser si newContext falla', async () => {
    let browserClosed = false;
    setBrowserLaunchForTests(async () => ({
      async newContext() {
        throw new Error('no context');
      },
      async close() {
        browserClosed = true;
      },
    }));
    await expect(openBrowserSession()).rejects.toThrow(/no context/);
    expect(browserClosed).toBe(true);
  });

  it('reutiliza la misma sesión para varias páginas', async () => {
    const closed = { browser: false, context: false };
    const urls: string[] = [];
    setBrowserLaunchForTests(async () => fakeBrowser({
      html: ARCHIVE_HTML,
      closed,
      async goto(url) {
        urls.push(url);
      },
    }));
    const session = recordedBrowserSession(await openBrowserSession(), 'browser-fetch-test');
    await session.get(ARCHIVE, { waitForSelector: READY });
    await session.get(`${ARCHIVE}page/2/`, { waitForSelector: READY });
    await session.close();
    expect(urls).toEqual([ARCHIVE, `${ARCHIVE}page/2/`]);
    const attempts = takeBrowserFetchAttempts('browser-fetch-test');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.browserFallback).toBe(true);
    expect(attempts[1]?.browserFallback).toBeUndefined();
  });
});
