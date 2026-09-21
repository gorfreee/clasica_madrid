import { expect, test, type Page } from '@playwright/test';
import { attributedShareUrl, canonicalShareUrl, whatsappShareHref } from '../src/lib/presentation/share.ts';

const SINGLE_EVENT = '/eventos/cuarteto-cosmos/';
const SEVERAL_DATES_EVENT = '/eventos/el-cascanueces/';
const PAST_EVENT = '/eventos/recital-de-piano/';
const LONG_TITLE_EVENT =
  '/eventos/xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma-26-orquesta-sinfonica-de-la-universidad-complutense/';
const VENUE = '/lugares/teatro-real/';
const VENUE_WITHOUT_WEB = '/lugares/real-monasterio-de-santa-isabel/';

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
}

function shareRoot(page: Page) {
  return page.locator('[data-share]');
}

async function sharePayloadFromDom(page: Page) {
  const root = shareRoot(page);
  const title = (await root.getAttribute('data-share-title')) ?? '';
  const text = (await root.getAttribute('data-share-text')) ?? '';
  const path = (await root.getAttribute('data-share-path')) ?? '';
  const contentType = (await root.getAttribute('data-share-content-type')) ?? '';
  const origin = new URL(page.url()).origin;
  const url = canonicalShareUrl(origin, path);
  return { title, text, path, contentType, url, origin };
}

type ContentSharedCall = {
  event: string;
  properties: { method: string; content_type: string; path: string };
};

async function installShareAnalytics(page: Page) {
  await page.addInitScript(() => {
    const calls: ContentSharedCall[] = [];
    (window as unknown as { __contentShared: ContentSharedCall[] }).__contentShared = calls;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      value: {
        capture(event: string, properties: ContentSharedCall['properties']) {
          calls.push({ event, properties });
        },
      },
    });
  });
}

async function contentSharedCalls(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __contentShared: ContentSharedCall[] }).__contentShared,
  );
}

test.describe('compartir en fichas', () => {
  test('sin JavaScript WhatsApp ya enlaza la URL atribuida', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      const page = await context.newPage();
      await page.goto(VENUE);
      const root = page.locator('[data-share]');
      const text = (await root.getAttribute('data-share-text')) ?? '';
      const path = (await root.getAttribute('data-share-path')) ?? '';
      const href = await page.locator('[data-share-whatsapp]').getAttribute('href');
      expect(href).toBe(
        whatsappShareHref(text, attributedShareUrl('https://clasicamadrid.com', path, 'whatsapp')),
      );
      expect(decodeURIComponent(href ?? '')).toContain('utm_source=whatsapp');
      expect(decodeURIComponent(href ?? '')).toContain('utm_medium=share');
    } finally {
      await context.close();
    }
  });

  test('sin token de PostHog no se inserta el snippet', async ({ page }) => {
    await page.goto(SINGLE_EVENT);
    const html = await page.content();
    expect(html).not.toContain('eu.i.posthog.com');
    expect(html).not.toContain('eu-assets.i.posthog.com');
    expect(html).not.toContain('array.js');
    expect(await page.evaluate(() => 'posthog' in window)).toBe(false);
  });

  test('la ficha de evento muestra Compartir y los listados no', async ({ page }) => {
    await page.goto(SINGLE_EVENT);
    const share = page.getByRole('button', { name: 'Compartir', exact: true });
    await expect(share).toBeVisible();
    await expect(shareRoot(page)).toHaveCount(1);
    await expect(page.locator('.event-actions').getByRole('button', { name: 'Compartir', exact: true })).toBeVisible();
    await expect(page.locator('.page-hero').getByRole('button', { name: 'Compartir', exact: true })).toHaveCount(0);
    await expect(page.locator('.agenda-item').getByText('Compartir', { exact: true })).toHaveCount(0);

    await page.goto('/');
    await expect(page.locator('[data-share]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Compartir', exact: true })).toHaveCount(0);

    await page.goto('/lugares/');
    await expect(page.locator('[data-share]')).toHaveCount(0);
    await expect(page.locator('.venue-list').getByText('Compartir', { exact: true })).toHaveCount(0);
  });

  test('la ficha de lugar muestra Compartir junto a la dirección y la web', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(VENUE);

    const practical = page.locator('.venue-detail__practical');
    const maps = practical.getByRole('link', { name: /Google Maps/ });
    const web = practical.getByRole('link', { name: /Web oficial/ });
    const share = practical.getByRole('button', { name: 'Compartir', exact: true });
    await expect(share).toBeVisible();

    const [mapsBox, webBox, shareBox] = await Promise.all([
      maps.boundingBox(),
      web.boundingBox(),
      share.boundingBox(),
    ]);
    expect(mapsBox && webBox && shareBox).toBeTruthy();
    expect(mapsBox!.y).toBeLessThan(webBox!.y);
    expect(webBox!.y).toBeLessThan(shareBox!.y);
    expect(Math.abs(mapsBox!.x - shareBox!.x)).toBeLessThan(4);
    expect(shareBox!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
  });

  test('un lugar sin web oficial sigue mostrando Compartir', async ({ page }) => {
    await page.goto(VENUE_WITHOUT_WEB);
    await expect(page.getByRole('link', { name: /Web oficial/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Compartir', exact: true })).toBeVisible();
    const { text } = await sharePayloadFromDom(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(text.split(' · ')[0] ?? '');
  });

  test('con navigator.share la acción abre el selector nativo y no el menú', async ({ page }) => {
    await installShareAnalytics(page);
    await page.addInitScript(() => {
      const calls: ShareData[] = [];
      (window as unknown as { __shareCalls: ShareData[] }).__shareCalls = calls;
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data: ShareData) => {
          calls.push(data);
          return Promise.resolve();
        },
      });
    });

    await page.goto(`${SINGLE_EVENT}?utm=boletin#programa`);
    const expected = await sharePayloadFromDom(page);
    const nativeUrl = attributedShareUrl(expected.origin, expected.path, 'native_share');
    expect(expected.contentType).toBe('event');
    expect(expected.text).toBe('Cuarteto Cosmos — 8 de enero, 19:30 · Auditorio Nacional de Música');
    expect(expected.url).not.toContain('utm');
    expect(expected.url).not.toContain('#');
    expect(nativeUrl).toBe(`${expected.origin}${expected.path}?utm_source=native_share&utm_medium=share`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://clasicamadrid.com${expected.path}`,
    );
    const siteHrefs = await page
      .locator('header a, footer a, link[rel="canonical"], meta[property="og:url"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? node.getAttribute('content') ?? ''));
    expect(siteHrefs.some((href) => href.includes('utm_'))).toBe(false);

    await page.getByRole('button', { name: 'Compartir', exact: true }).click();
    await expect(page.locator('[data-share-menu]')).toBeHidden();
    await expect(page.locator('[data-share-feedback]')).toHaveText('');

    const calls = await page.evaluate(() => (window as unknown as { __shareCalls: ShareData[] }).__shareCalls);
    expect(calls).toEqual([{ title: expected.title, text: expected.text, url: nativeUrl }]);
    expect(await contentSharedCalls(page)).toEqual([
      {
        event: 'content_shared',
        properties: { method: 'native_share', content_type: 'event', path: expected.path },
      },
    ]);
  });

  test('cancelar el selector nativo no muestra error ni el menú', async ({ page }) => {
    await installShareAnalytics(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: () => true,
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Share canceled', 'AbortError')),
      });
    });

    await page.goto(SINGLE_EVENT);
    await page.getByRole('button', { name: 'Compartir', exact: true }).click();
    await expect(page.locator('[data-share-menu]')).toBeHidden();
    await expect(page.locator('[data-share-feedback]')).toHaveText('');
    await expect(page.getByText('Enlace copiado')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await contentSharedCalls(page)).toEqual([]);
  });

  test('si los datos no son compartibles aparece el fallback', async ({ page }) => {
    await installShareAnalytics(page);
    await page.addInitScript(() => {
      (window as unknown as { __shareCalls: number }).__shareCalls = 0;
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: () => false,
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: () => {
          (window as unknown as { __shareCalls: number }).__shareCalls += 1;
          return Promise.resolve();
        },
      });
    });

    await page.goto(SEVERAL_DATES_EVENT);
    const { text } = await sharePayloadFromDom(page);
    expect(text).toBe('El Cascanueces · Real Teatro de Retiro — varias fechas');

    await page.getByRole('button', { name: 'Compartir', exact: true }).click();
    await expect(page.locator('[data-share-menu]')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __shareCalls: number }).__shareCalls)).toBe(0);
    expect(await contentSharedCalls(page)).toEqual([]);
  });

  test('sin Web Share el fallback ofrece WhatsApp y copiar el enlace atribuido', async ({ page }) => {
    await installShareAnalytics(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${VENUE}?origen=preview#mapa`);

    const share = page.getByRole('button', { name: 'Compartir', exact: true });
    await share.click();

    const expected = await sharePayloadFromDom(page);
    const whatsappUrl = attributedShareUrl(expected.origin, expected.path, 'whatsapp');
    const copyUrl = attributedShareUrl(expected.origin, expected.path, 'copy_link');
    expect(expected.contentType).toBe('venue');
    expect(expected.text).toBe('Teatro Real · Madrid');
    expect(expected.url).not.toContain('origen');
    expect(expected.url).not.toContain('#');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://clasicamadrid.com${expected.path}`,
    );
    const whatsapp = page.getByRole('link', { name: /WhatsApp/ });
    await expect(whatsapp).toBeVisible();
    await expect(whatsapp).toHaveAttribute('href', whatsappShareHref(expected.text, whatsappUrl));
    await expect(whatsapp).toHaveAttribute('target', '_blank');
    await expect(whatsapp).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByRole('button', { name: 'Copiar enlace', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Telegram|Facebook|LinkedIn|Correo/ })).toHaveCount(0);
    const trackedHrefs = await page.locator('a[href*="utm_"]').evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('href') ?? '')
        .filter((href) => !href.startsWith('https://wa.me/')),
    );
    expect(trackedHrefs).toEqual([]);

    await page.getByRole('button', { name: 'Copiar enlace', exact: true }).click();
    const feedback = page.locator('[data-share-feedback]');
    await expect(feedback).toHaveAttribute('role', 'status');
    await expect(feedback).toHaveText('Enlace copiado');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copyUrl);

    await page.route('https://wa.me/**', (route) => route.fulfill({ status: 204, body: '' }));
    const [popup] = await Promise.all([page.waitForEvent('popup'), whatsapp.click()]);
    await popup.close();
    expect(await contentSharedCalls(page)).toEqual([
      {
        event: 'content_shared',
        properties: { method: 'copy_link', content_type: 'venue', path: expected.path },
      },
      {
        event: 'content_shared',
        properties: { method: 'whatsapp', content_type: 'venue', path: expected.path },
      },
    ]);
  });

  test('un evento sin acción de fuente sigue pudiendo compartirse', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    await page.route('**/eventos/cuarteto-cosmos/**', async (route) => {
      if (route.request().resourceType() !== 'document') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const headers = response.headers();
      delete headers['content-length'];
      delete headers['content-encoding'];
      const body = (await response.text()).replace(
        /<a\b(?=[^>]*\bexternal-action--cta\b)[^>]*>[\s\S]*?<\/a>/,
        '',
      );
      await route.fulfill({
        status: response.status(),
        headers,
        body,
      });
    });

    await page.goto(SINGLE_EVENT);
    await expect(page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ })).toHaveCount(0);
    const share = page.locator('.event-actions').getByRole('button', { name: 'Compartir', exact: true });
    await expect(share).toBeVisible();
    await share.click();
    await expect(page.getByRole('link', { name: /WhatsApp/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copiar enlace', exact: true })).toBeVisible();
  });

  test('el fallback se recorre con teclado y se cierra con Escape', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    await page.goto(SINGLE_EVENT);

    const share = page.getByRole('button', { name: 'Compartir', exact: true });
    await share.focus();
    await expect(share).toBeFocused();
    await page.keyboard.press('Enter');

    const whatsapp = page.getByRole('link', { name: /WhatsApp/ });
    const copy = page.getByRole('button', { name: 'Copiar enlace', exact: true });
    await expect(whatsapp).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(whatsapp).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(copy).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-share-menu]')).toBeHidden();
    await expect(share).toBeFocused();
  });

  test('no desborda en escritorio, tablet ni móvil', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      for (const route of [SINGLE_EVENT, LONG_TITLE_EVENT, PAST_EVENT, VENUE, VENUE_WITHOUT_WEB]) {
        await page.goto(route);
        await expect(page.getByRole('button', { name: 'Compartir', exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(SINGLE_EVENT);
    const cta = page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ });
    const share = page.getByRole('button', { name: 'Compartir', exact: true });
    const [ctaBox, shareBox] = await Promise.all([cta.boundingBox(), share.boundingBox()]);
    expect(ctaBox && shareBox).toBeTruthy();
    expect(shareBox!.x).toBeGreaterThan(ctaBox!.x + ctaBox!.width - 1);
    expect(Math.abs(shareBox!.y - ctaBox!.y)).toBeLessThan(8);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(SINGLE_EVENT);
    const [mobileCta, mobileShare] = await Promise.all([
      page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ }).boundingBox(),
      page.getByRole('button', { name: 'Compartir', exact: true }).boundingBox(),
    ]);
    expect(mobileCta && mobileShare).toBeTruthy();
    expect(mobileShare!.y).toBeGreaterThan(mobileCta!.y + mobileCta!.height - 1);
    expect(mobileShare!.x).toBeLessThan(mobileCta!.x + 12);

    await page.goto(PAST_EVENT);
    const notice = await page.locator('.past-notice').boundingBox();
    const pastShare = await page.getByRole('button', { name: 'Compartir', exact: true }).boundingBox();
    expect(notice && pastShare).toBeTruthy();
    expect(pastShare!.y).toBeGreaterThan(notice!.y);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(SINGLE_EVENT);
    await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>('.event-actions');
      const shareNode = document.querySelector<HTMLElement>('[data-share]');
      if (!actions || !shareNode) return;
      actions.style.width = '100%';
      shareNode.style.marginLeft = 'auto';
    });
    await page.getByRole('button', { name: 'Compartir', exact: true }).click();
    const menu = page.locator('[data-share-menu]');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox).toBeTruthy();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390 + 1);
    await expectNoHorizontalOverflow(page);
  });
});
