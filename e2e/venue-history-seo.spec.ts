import { expect, test } from '@playwright/test';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { blogContentDir, blogLastmodsFromDirectory } from '../src/lib/blog/files.ts';
import { buildVenuePageModel, VENUE_HISTORY_LIMIT } from '../src/lib/presentation/venue.ts';
import { eventPath, publicUrl } from '../src/lib/presentation/urls.ts';

async function venuePages() {
  const catalog = await loadCatalogFromDir(defaultDataDir());
  const pages = catalog.venues.map((venue) => buildVenuePageModel(catalog, venue.slug)!);
  return { catalog, pages };
}

test('las fichas públicas y el sitemap comparten indexabilidad; solo el blog tiene lastmod', async ({ request }) => {
  const { catalog, pages } = await venuePages();
  const index = await request.get('/sitemap-index.xml');
  expect(index.ok()).toBe(true);
  const sitemapPaths = [...(await index.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => new URL(match[1]!).pathname);
  const parts = await Promise.all(sitemapPaths.map(async (path) => {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    return response.text();
  }));
  const entries = new Map([...parts.join('\n').matchAll(/<url>(.*?)<\/url>/gs)].map((match) => [
    match[1]!.match(/<loc>([^<]+)<\/loc>/)?.[1],
    match[1]!.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1],
  ]));
  const venuesIndex = await request.get('/lugares/');
  const indexHtml = await venuesIndex.text();
  for (const model of pages) {
    const response = await request.get(model.canonicalPath);
    expect(response.status(), model.slug).toBe(200);
    const html = await response.text();
    expect(/<meta name="robots" content="[^"]*noindex/.test(html), model.slug).toBe(!model.indexable);
    const url = publicUrl(model.canonicalPath);
    expect(entries.has(url), model.slug).toBe(model.indexable);
    expect(entries.get(url), model.slug).toBeUndefined();
    if (!catalog.venues.find((venue) => venue.slug === model.slug)?.parentVenueId) {
      expect(indexHtml, model.slug).toContain(`href="${model.canonicalPath}"`);
    }
    if (model.upcoming.length > 0) {
      expect(html).toContain('Próximos conciertos</h2>');
      expect(html).not.toContain('Conciertos anteriores</h2>');
    } else if (model.hasHistory) {
      expect(html).toContain('Conciertos anteriores</h2>');
      expect(html).not.toContain('No hay conciertos próximos publicados en este espacio');
      expect([...html.matchAll(/data-occurrence-id=/g)]).toHaveLength(model.previous.length);
      expect(model.previous.length).toBeLessThanOrEqual(VENUE_HISTORY_LIMIT);
    } else {
      expect(html).toContain('No hay conciertos próximos publicados en este espacio');
      expect(html).not.toContain('data-occurrence-id=');
    }
  }
  for (const path of ['/', '/lugares/', '/agenda/gratis/', '/agenda/fin-de-semana/']) {
    expect(entries.has(publicUrl(path)), path).toBe(true);
    expect(entries.get(publicUrl(path)), path).toBeUndefined();
  }
  for (const event of catalog.events) {
    const url = publicUrl(eventPath(event.slug));
    expect(entries.has(url), event.slug).toBe(true);
    expect(entries.get(url), event.slug).toBeUndefined();
    for (const alias of event.slugAliases ?? []) expect(entries.has(publicUrl(eventPath(alias)))).toBe(false);
  }
  const blogDates = blogLastmodsFromDirectory(blogContentDir());
  expect(blogDates.size).toBeGreaterThan(0);
  for (const [path, date] of blogDates) expect(entries.get(publicUrl(path))?.slice(0, 10), path).toBe(date);
  for (const [url, lastmod] of entries) {
    if (lastmod) expect(new URL(url!).pathname).toMatch(/^\/blog\//);
  }
});

test('el archivo cabe en móvil/escritorio y mantiene navegación evento → lugar', async ({ page }) => {
  const { pages } = await venuePages();
  const archive = pages.find((model) => !model.upcoming.length && model.hasHistory);
  test.skip(!archive, 'El catálogo actual no contiene un lugar con archivo y sin próximos.');
  const model = archive!;
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(model.canonicalPath);
    await expect(page.getByRole('heading', { name: 'Conciertos anteriores', exact: true })).toBeVisible();
    await expect(page.locator('[data-occurrence-id]')).toHaveCount(model.previous.length);
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', publicUrl(model.canonicalPath));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
      await page.evaluate(() => document.documentElement.clientWidth),
    );
    expect(await page.locator('[data-occurrence-id] time').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime'))))
      .toEqual(model.previous.map((item) => item.date));
  }
  const item = model.previous[0]!;
  await page.locator('.agenda-item__title a').first().click();
  await expect(page).toHaveURL(item.href);
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  await page.locator(`article a[href="${item.venueHref}"]`).first().click();
  await expect(page).toHaveURL(item.venueHref);
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
});
