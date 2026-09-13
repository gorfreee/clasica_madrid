import { expect, test } from '@playwright/test';

const pages = [
  { path: '/', variant: 'agenda', hero: '.agenda-intro' },
  { path: '/lugares/', variant: 'venues', hero: '.section-intro' },
  { path: '/acerca-de/', variant: 'about', hero: '.section-intro' },
  {
    path: '/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/',
    variant: 'event',
    hero: '.detail-hero',
  },
  {
    path: '/lugares/basilica-pontificia-de-san-miguel/',
    variant: 'venue',
    hero: '.detail-hero',
  },
] as const;

for (const viewport of [
  { name: 'escritorio', width: 1440, height: 900 },
  { name: 'móvil estrecho', width: 320, height: 700 },
] as const) {
  test.describe(`motivos de hero en ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const pageCase of pages) {
      test(`${pageCase.variant} es decorativo, ligero y no desborda`, async ({ page }) => {
        await page.goto(pageCase.path);

        const hero = page.locator(pageCase.hero).first();
        const motif = hero.locator(`[data-hero-motif="${pageCase.variant}"]`);
        await expect(hero.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(motif).toHaveCount(1);
        await expect(motif).toHaveAttribute('aria-hidden', 'true');
        await expect(motif).toHaveAttribute('focusable', 'false');
        await expect(motif.locator('image, filter, script, animate, animateTransform')).toHaveCount(0);

        const layout = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(layout.scrollWidth).toBe(layout.clientWidth);

        const contentFits = await hero.evaluate((element) => {
          const heroRect = element.getBoundingClientRect();
          const content = element.querySelectorAll<HTMLElement>(
            ':scope > .eyebrow, :scope > .agenda-intro__copy, :scope > h1, :scope > .status-alert, :scope > .detail-hero__series, :scope > .venue-detail__practical',
          );
          return [...content].every((child) => child.getBoundingClientRect().bottom <= heroRect.bottom + 1);
        });
        expect(contentFits).toBe(true);
      });
    }
  });
}

test('las hero de índice mantienen una altura compacta', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const path of ['/', '/lugares/', '/acerca-de/']) {
    await page.goto(path);
    const height = await page
      .locator('header.agenda-intro, header.section-intro')
      .first()
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(270);
    expect(height).toBeLessThanOrEqual(310);
  }
});
