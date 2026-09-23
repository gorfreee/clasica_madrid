import { expect, test, type Page } from '@playwright/test';

// The agenda landings use the same hero layout as `/` and are also covered
// by the motif and landing-specific browser tests.
const INDEX_ROUTES = ['/', '/lugares/'] as const;
const DETAIL_ROUTES = [
  '/eventos/cuarteto-cosmos/',
  '/eventos/xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma-26-orquesta-sinfonica-de-la-universidad-complutense/',
  '/lugares/teatro-real/',
  '/lugares/auditorio-del-conservatorio-profesional-de-musica-de-getafe/',
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));

  expect(widths.scroll).toBe(widths.client);
}

async function expectSeparateGridTracks(page: Page) {
  const geometry = await page.locator('[data-page-hero]').evaluate((hero) => {
    const copy = hero.querySelector<HTMLElement>('.page-hero__copy')!.getBoundingClientRect();
    const artwork = hero.querySelector<HTMLElement>('.page-hero__artwork')!.getBoundingClientRect();
    return { copyRight: copy.right, artworkLeft: artwork.left };
  });

  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.artworkLeft);
}

test.describe('título de lugares', () => {
  test('el h1 dice Dónde suena / la música en dos líneas', async ({ page }) => {
    const heading = page.getByRole('heading', { level: 1 });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/lugares/');
      await page.evaluate(() => document.fonts.ready);

      await expect(heading).toHaveText('Dónde suena la música');

      const lines = await heading.evaluate((element) =>
        [...element.querySelectorAll('span')].map((line) => ({
          text: line.textContent?.trim() ?? '',
          boxes: line.getClientRects().length,
        })),
      );

      expect(lines, `líneas a ${viewport.width}px`).toEqual([
        { text: 'Dónde suena', boxes: 1 },
        { text: 'la música', boxes: 1 },
      ]);
      await expectNoHorizontalOverflow(page);
    }
  });
});

test.describe('título de la home', () => {
  test('el h1 dice Toda la / música clásica / en Madrid en tres líneas', async ({ page }) => {
    const heading = page.getByRole('heading', { level: 1 });

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);

      await expect(heading).toHaveText('Toda la música clásica en Madrid');

      const lines = await heading.evaluate((element) =>
        [...element.querySelectorAll('span')].map((line) => ({
          text: line.textContent?.trim() ?? '',
          boxes: line.getClientRects().length,
        })),
      );

      expect(lines, `líneas a ${viewport.width}px`).toEqual([
        { text: 'Toda la', boxes: 1 },
        { text: 'música clásica', boxes: 1 },
        { text: 'en Madrid', boxes: 1 },
      ]);
      await expectNoHorizontalOverflow(page);
    }
  });
});

test.describe('sistema de ilustraciones de hero', () => {
  test('las portadas escalan la ilustración sin solapar ni desbordar', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900, minArtwork: 260, maxArtwork: 340 },
      { width: 820, height: 900, minArtwork: 160, maxArtwork: 216 },
      { width: 390, height: 844, minArtwork: 70, maxArtwork: 100 },
    ]) {
      await page.setViewportSize(viewport);

      for (const route of INDEX_ROUTES) {
        await page.goto(route);
        const artwork = page.locator('.page-hero__artwork');
        await expect(artwork).toBeVisible();

        const width = await artwork.evaluate((element) => element.getBoundingClientRect().width);
        expect(width).toBeGreaterThanOrEqual(viewport.minArtwork);
        expect(width).toBeLessThanOrEqual(viewport.maxArtwork);
        await expectSeparateGridTracks(page);
        await expectNoHorizontalOverflow(page);
      }
    }
  });

  test('las fichas no reservan columna gráfica y el título usa todo el ancho', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);

      for (const route of DETAIL_ROUTES) {
        await page.goto(route);
        await expect(page.locator('[data-hero-motif]')).toHaveCount(0);
        await expect(page.locator('.page-hero__artwork')).toHaveCount(0);

        const geometry = await page.locator('.page-hero--detail').evaluate((hero) => {
          const heroBox = hero.getBoundingClientRect();
          const title = hero.querySelector('h1');
          if (!title) throw new Error('Falta el título de la ficha');
          const titleBox = title.getBoundingClientRect();
          return {
            heroWidth: heroBox.width,
            titleWidth: titleBox.width,
            titleLeft: titleBox.left,
            heroLeft: heroBox.left,
          };
        });

        expect(geometry.titleLeft).toBeCloseTo(geometry.heroLeft, 0);
        expect(geometry.titleWidth).toBeCloseTo(geometry.heroWidth, 0);
        await expectNoHorizontalOverflow(page);
      }
    }
  });
});
