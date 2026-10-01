import { expect, test } from '@playwright/test';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { listUpcomingOccurrences } from '../src/lib/domain/index.ts';

const TITLE = 'Ibermúsica. London Philharmonic Orchestra';
const LONDON = [
  { slug: 'ibermusica-london-philharmonic-orchestra', date: '28 oct 2026', composer: 'Jean Sibelius', excluded: 'Piotr Ilich Chaikovski' },
  { slug: 'ibermusica-london-philharmonic-orchestra-2', date: '29 oct 2026', composer: 'Piotr Ilich Chaikovski', excluded: 'Jean Sibelius' },
];

test('London Philharmonic mantiene H1 y MusicEvent, pero diferencia title y description', async ({ page }) => {
  const descriptions: string[] = [];
  for (const event of LONDON) {
    await page.goto(`/eventos/${event.slug}/`);
    await expect(page).toHaveTitle(`${TITLE} · ${event.date} · Auditorio Nacional de Música — Clásica Madrid`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE);
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toContain(event.composer);
    expect(description).not.toContain(event.excluded);
    expect(description).toContain('Julia Fischer');
    expect(description!.length).toBeLessThanOrEqual(360);
    descriptions.push(description!);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://clasicamadrid.com/eventos/${event.slug}/`);
    const entities = await page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
      scripts.flatMap((script) => {
        const data = JSON.parse(script.textContent!);
        return Array.isArray(data) ? data : [data];
      }).filter((item) => item['@type'] === 'MusicEvent'));
    expect(entities).toHaveLength(1);
    expect(entities[0].name).toBe(TITLE);
    expect(entities[0].startDate).toMatch(/2026-10-(28|29)T19:30:00\+01:00/);
    expect(entities[0]).not.toHaveProperty('offers');
  }
  expect(descriptions[0]).not.toBe(descriptions[1]);
  expect(descriptions[0]).toContain('Daniel Müller-Schott');
  expect(descriptions[1]).not.toContain('Daniel Müller-Schott');
});

test('la navegación contextual funciona en fichas futuras y de archivo, también en móvil', async ({ page }) => {
  const catalog = await loadCatalogFromDir(defaultDataDir());
  for (const route of ['/eventos/ibermusica-london-philharmonic-orchestra/', '/eventos/recital-de-piano/']) {
    const current = catalog.events.find((event) => route === `/eventos/${event.slug}/`)!;
    const upcoming = listUpcomingOccurrences(catalog);
    const currentVenue = catalog.venues.find((venue) => venue.id === current.venueId)!;
    const principalId = currentVenue.parentVenueId ?? currentVenue.id;
    const principal = catalog.venues.find((venue) => venue.id === principalId)!;
    const seen = new Set([current.id]);
    const expected = upcoming.filter(({ resolved }) => {
      if (resolved.rootVenue.id !== principalId || seen.has(resolved.event.id)) return false;
      seen.add(resolved.event.id);
      return true;
    }).slice(0, 3);
    expect(expected.length).toBeGreaterThan(0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      const section = page.getByRole('region', { name: `Más conciertos en ${principal.name}` });
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      const cards = section.locator('[data-occurrence-id]');
      await expect(cards).toHaveCount(expected.length);
      expect(await cards.locator('h3 a').evaluateAll((links) => links.map((link) => link.getAttribute('href'))))
        .toEqual(expected.map(({ resolved }) => `/eventos/${resolved.event.slug}/`));
      expect(await cards.locator('time').evaluateAll((times) => times.map((time) => time.getAttribute('datetime'))))
        .toEqual(expected.map(({ occurrence }) => occurrence.date));
      await expect(section.locator(`a[href="${route}"]`)).toHaveCount(0);
      const widthInfo = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(widthInfo.scroll).toBe(widthInfo.client);
    }
    const link = page.locator('.related-concerts h3 a').first();
    const target = await link.getAttribute('href');
    await link.click();
    await expect(page).toHaveURL(target!);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(expected[0]!.resolved.event.title);
  }
});

test('no renderiza sección ni encabezado de relacionados sin otros conciertos próximos', async ({ page }) => {
  const catalog = await loadCatalogFromDir(defaultDataDir());
  const upcoming = listUpcomingOccurrences(catalog);
  const candidate = catalog.events.find((event) => {
    const venue = catalog.venues.find((item) => item.id === event.venueId)!;
    const principalId = venue.parentVenueId ?? venue.id;
    return !upcoming.some(({ resolved }) => resolved.rootVenue.id === principalId && resolved.event.id !== event.id);
  });
  expect(candidate).toBeTruthy();
  await page.goto(`/eventos/${candidate!.slug}/`);
  await expect(page.locator('.related-concerts')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Más conciertos en / })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(candidate!.title);
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
});
