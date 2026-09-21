import { expect, test } from '@playwright/test';

const pages = [
  { path: '/', variant: 'agenda', hero: '.page-hero--agenda', kind: 'index' },
  { path: '/lugares/', variant: 'venues', hero: '.page-hero--venues', kind: 'index' },
  {
    path: '/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/',
    variant: 'event',
    hero: '.page-hero--event',
    kind: 'detail',
  },
  {
    path: '/lugares/basilica-pontificia-de-san-miguel/',
    variant: 'venue',
    hero: '.page-hero--venue',
    kind: 'detail',
  },
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

    for (const pageCase of pages) {
      test(`${pageCase.variant} conserva la composición y no desborda`, async ({ page }) => {
        await page.goto(pageCase.path);

        const hero = page.locator(pageCase.hero).first();
        const motif = hero.locator(`[data-hero-motif="${pageCase.variant}"]`);
        await expect(hero.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(motif).toHaveCount(1);
        await expect(motif).toHaveAttribute('aria-hidden', 'true');
        await expect(motif).toHaveAttribute('focusable', 'false');
        await expect(motif.locator('image, filter, script, animate, animateTransform')).toHaveCount(0);

        const detailMotifIsHidden = pageCase.kind === 'detail' && viewport.width <= 620;
        if (detailMotifIsHidden) {
          await expect(motif).toBeHidden();
        } else {
          await expect(motif).toBeVisible();
        }

        const layout = await hero.evaluate((element, { variant, kind }) => {
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
            kind,
          };
        }, { variant: pageCase.variant, kind: pageCase.kind });

        expect(layout.pageScrollWidth).toBe(layout.pageClientWidth);
        expect(layout.contentFits).toBe(true);
        expect(layout.clipPath).toBe('none');
        if (detailMotifIsHidden) {
          expect(layout.motifArea).toBe(0);
        } else {
          const minimumVisibleFraction = pageCase.kind === 'index' ? .9 : .95;
          expect(layout.motifVisibleFraction).toBeGreaterThanOrEqual(minimumVisibleFraction);
        }
        if (layout.kind === 'index') {
          expect(layout.heroHeight).toBeLessThanOrEqual(viewport.height * .48);
        }
      });
    }
  });
}
