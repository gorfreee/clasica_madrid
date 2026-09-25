import { expect, test } from '@playwright/test';

const indexPages = [
  { path: '/', variant: 'agenda', hero: '.page-hero--agenda' },
  { path: '/lugares/', variant: 'venues', hero: '.page-hero--venues' },
] as const;

const landingPages = [
  { path: '/agenda/gratis/', variant: 'agenda', hero: '.page-hero--agenda' },
  { path: '/agenda/fin-de-semana/', variant: 'agenda', hero: '.page-hero--agenda' },
] as const;

const pagesWithoutMotif = [
  '/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/',
  '/eventos/xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma-26-orquesta-sinfonica-de-la-universidad-complutense/',
  '/lugares/basilica-pontificia-de-san-miguel/',
  '/lugares/teatro-real/',
  '/acerca-de/',
  '/contacto/',
  '/blog/',
] as const;

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '768', width: 768, height: 900 },
  { name: '412', width: 412, height: 915 },
  { name: '320', width: 320, height: 700 },
] as const;

for (const viewport of viewports) {
  test.describe(`motivos de hero a ${viewport.name}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    // The landings share the agenda hero; check each route at a mobile width
    // while covering the two distinct hero variants at every breakpoint.
    for (const pageCase of [...indexPages, ...(viewport.width === 412 ? landingPages : [])]) {
      test(`${pageCase.variant} en ${pageCase.path} conserva la composición y no desborda`, async ({ page }) => {
        await page.goto(pageCase.path);

        const hero = page.locator(pageCase.hero).first();
        const motif = hero.locator(`[data-hero-motif="${pageCase.variant}"]`);
        await expect(hero.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(motif).toHaveCount(1);
        await expect(motif).toHaveAttribute('aria-hidden', 'true');
        await expect(motif).toHaveAttribute('focusable', 'false');
        await expect(motif.locator('image, filter, script, animate, animateTransform')).toHaveCount(0);
        await expect(motif).toBeVisible();

        const layout = await hero.evaluate((element, variant) => {
          const heroRect = element.getBoundingClientRect();
          const svg = element.querySelector<SVGElement>(`[data-hero-motif="${variant}"]`);
          const copy = element.querySelector<HTMLElement>('.page-hero__copy');
          if (!svg || !copy) throw new Error('Falta el motivo o el bloque de contenido de la hero');

          const motifRect = svg.getBoundingClientRect();
          const overlapWidth = Math.max(
            0,
            Math.min(heroRect.right, motifRect.right) - Math.max(heroRect.left, motifRect.left),
          );
          const overlapHeight = Math.max(
            0,
            Math.min(heroRect.bottom, motifRect.bottom) - Math.max(heroRect.top, motifRect.top),
          );
          const motifArea = motifRect.width * motifRect.height;
          const computed = getComputedStyle(svg);

          return {
            pageClientWidth: document.documentElement.clientWidth,
            pageScrollWidth: document.documentElement.scrollWidth,
            contentFits: copy.getBoundingClientRect().bottom <= heroRect.bottom + 1,
            motifVisibleFraction: motifArea > 0 ? (overlapWidth * overlapHeight) / motifArea : 0,
            clipPath: computed.clipPath,
            heroHeight: heroRect.height,
            motifArea,
          };
        }, pageCase.variant);

        expect(layout.pageScrollWidth).toBe(layout.pageClientWidth);
        expect(layout.contentFits).toBe(true);
        expect(layout.clipPath).toBe('none');
        expect(layout.motifArea).toBeGreaterThan(0);
        expect(layout.motifVisibleFraction).toBeGreaterThanOrEqual(0.9);
        if (pageCase.path === '/' || pageCase.path === '/lugares/') {
          expect(layout.heroHeight).toBeLessThanOrEqual(viewport.height * 0.48);
        }
      });
    }
  });
}

test('las fichas y las páginas editoriales no tienen motivo gráfico', async ({ page }) => {
  for (const path of pagesWithoutMotif) {
    await page.goto(path);
    await expect(page.locator('[data-hero-motif]'), path).toHaveCount(0);
    await expect(page.locator('.page-hero__artwork'), path).toHaveCount(0);
  }
});
