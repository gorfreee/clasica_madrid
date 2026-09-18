import { expect, test, type Page } from '@playwright/test';

const INDEX_ROUTES = ['/', '/lugares/'] as const;
const DETAIL_ROUTES = [
  '/eventos/cuarteto-cosmos/',
  '/eventos/concierto-de-la-orquesta-barroca-del-rcsmm-jose-de-nebra-en-el-museo-del-prado/',
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

  test('las fichas mantienen una columna gráfica discreta en tablet y escritorio', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900, minArtwork: 110, maxArtwork: 160 },
      { width: 820, height: 900, minArtwork: 110, maxArtwork: 160 },
    ]) {
      await page.setViewportSize(viewport);

      for (const route of DETAIL_ROUTES) {
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

  test('las fichas móviles eliminan la ilustración y liberan todo el ancho del título', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    for (const route of DETAIL_ROUTES) {
      await page.goto(route);
      await expect(page.locator('.page-hero__artwork')).toBeHidden();

      const geometry = await page.locator('[data-page-hero]').evaluate((hero) => {
        const heroBox = hero.getBoundingClientRect();
        const titleBox = hero.querySelector('h1')!.getBoundingClientRect();
        return { heroWidth: heroBox.width, titleWidth: titleBox.width };
      });

      expect(geometry.titleWidth).toBeCloseTo(geometry.heroWidth, 0);
      await expectNoHorizontalOverflow(page);
    }
  });
});
