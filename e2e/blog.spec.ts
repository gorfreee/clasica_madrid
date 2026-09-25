import { expect, test } from '@playwright/test';

async function sitemapXml(request: { get: (url: string) => Promise<{ ok: () => boolean; text: () => Promise<string> }> }) {
  const index = await request.get('/sitemap-index.xml');
  expect(index.ok()).toBe(true);
  const locs = [...(await index.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
  const pages = locs.filter((loc) => loc.endsWith('.xml'));
  expect(pages.length).toBeGreaterThan(0);
  const chunks = await Promise.all(
    pages.map(async (loc) => {
      const path = new URL(loc).pathname;
      const sitemap = await request.get(path);
      expect(sitemap.ok()).toBe(true);
      return sitemap.text();
    }),
  );
  return chunks.join('\n');
}

test.describe('blog', () => {
  test('el índice es una página editorial indexable y no publica el fixture', async ({ page }) => {
    await page.goto('/blog/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Historias para\s*escuchar Madrid/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://clasicamadrid.com/blog/',
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website');
    const jsonLd = await page.locator('script[type="application/ld+json"]').evaluate((node) => node.textContent ?? '');
    expect(jsonLd).toContain('CollectionPage');
    const analytics = await page.locator('#analytics-page').evaluate((node) => node.textContent ?? '');
    expect(analytics).toContain('"page_type":"blog"');
    await expect(page.getByText('Todavía no hay artículos publicados')).toBeVisible();
    await expect(page.getByText('fixture-sistema-editorial')).toHaveCount(0);
    await expect(page.getByText('Pieza de prueba del sistema editorial')).toHaveCount(0);
    await expect(page).not.toHaveURL(/fixture-sistema-editorial/);
  });

  test('no desborda en móvil y Blog queda activo en Más y en el menú', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/blog/');

    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBe(widths.client);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const menu = page.getByRole('button', { name: 'Menú de secciones' });
    await menu.click();
    const mobile = page.locator('#nav-mobile-panel');
    await expect(mobile.getByRole('link', { name: 'Blog' })).toHaveAttribute('aria-current', 'page');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/blog/');
    const more = page.getByRole('button', { name: 'Más' });
    await expect(more).toHaveAttribute('aria-current', 'true');
    await more.click();
    await expect(page.locator('#nav-more-panel').getByRole('link', { name: 'Blog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('el sitemap incluye /blog/ y omite el borrador', async ({ request }) => {
    const xml = await sitemapXml(request);
    expect(xml).toContain('https://clasicamadrid.com/blog/');
    expect(xml).not.toContain('fixture-sistema-editorial');
  });

  test('el borrador no tiene URL pública', async ({ request }) => {
    const response = await request.get('/blog/fixture-sistema-editorial/');
    expect(response.status()).toBe(404);
  });
});
