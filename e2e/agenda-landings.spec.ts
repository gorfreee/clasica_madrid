import { expect, test } from '@playwright/test';

async function sitemapXml(request: { get: (url: string) => Promise<{ ok: () => boolean; text: () => Promise<string> }> }) {
  const index = await request.get('/sitemap-index.xml');
  expect(index.ok()).toBe(true);
  const indexXml = await index.text();
  const locs = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!).pathname);
  expect(locs.length).toBeGreaterThan(0);
  const parts = await Promise.all(
    locs.map(async (path) => {
      const sitemap = await request.get(path);
      expect(sitemap.ok()).toBe(true);
      return sitemap.text();
    }),
  );
  return parts.join('\n');
}

test.describe('landings SEO de agenda', () => {
  test('gratis e fin-de-semana son páginas indexables con canonical propio', async ({ page }) => {
    await page.goto('/agenda/gratis/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Conciertos gratis de música clásica en Madrid',
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://clasicamadrid.com/agenda/gratis/',
    );
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(0);

    const freeItems = page.locator('[data-occurrence-id]');
    const freeEmpty = page.getByRole('status');
    expect((await freeItems.count()) + (await freeEmpty.count())).toBeGreaterThan(0);

    await page.goto('/agenda/fin-de-semana/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Conciertos de música clásica en Madrid este fin de semana',
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://clasicamadrid.com/agenda/fin-de-semana/',
    );
    await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(0);
    const weekendList = page.locator('[data-agenda-list]');
    const weekendEmpty = page.getByRole('status');
    expect((await weekendList.count()) + (await weekendEmpty.count())).toBeGreaterThan(0);
  });

  test('la home filtrada conserva el canonical de /', async ({ page }) => {
    await page.goto('/?access=free');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://clasicamadrid.com/',
    );
  });

  test('no existen landings automáticas fuera de la whitelist', async ({ request }) => {
    expect((await request.get('/agenda/opera/')).status()).toBe(404);
    expect((await request.get('/agenda/hoy/')).status()).toBe(404);
    expect((await request.get('/agenda/zarzuela/')).status()).toBe(404);
    expect((await request.get('/agenda/gratis/fin-de-semana/')).status()).toBe(404);
    expect((await request.get('/agenda/gratis/')).ok()).toBe(true);
    expect((await request.get('/agenda/fin-de-semana/')).ok()).toBe(true);
  });

  test('el sitemap incluye las dos landings y no query params', async ({ request }) => {
    const xml = await sitemapXml(request);
    expect(xml).toContain('https://clasicamadrid.com/agenda/gratis/');
    expect(xml).toContain('https://clasicamadrid.com/agenda/fin-de-semana/');
    expect(xml).not.toContain('/agenda/opera/');
    expect(xml).not.toContain('access=free');
    expect(xml).not.toContain('/_agenda');
  });
});
