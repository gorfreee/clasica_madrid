import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Astro preview serves the SSG assets only. Header coverage lives in
// tests/agenda-filter-seo.test.ts against the actual Pages onRequest handler.
for (const path of [
  '/', '/?access=free', '/?access=free&composer=bach&from=2026-10-01&to=2026-10-04',
  '/?utm_source=test&utm_medium=whatsapp', '/?unknown=value',
]) {
  test(`la home conserva el canonical / y sus filtros en ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://clasicamadrid.com/');
    // SSG HTML is shared; no build-time noindex can leak to the plain home.
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    if (new URL(page.url()).searchParams.get('access') === 'free') {
      await expect(page.locator('select[name="access"]')).toHaveValue('free');
      await expect(page.locator('[data-agenda-shortcut="free"]')).toHaveAttribute('aria-pressed', 'true');
    }
    if (new URL(page.url()).searchParams.has('composer')) {
      await expect(page.locator('input[name="composer"]')).toHaveValue('bach');
      await expect(page.locator('input[name="from"]')).toHaveValue('2026-10-01');
      await expect(page.locator('input[name="to"]')).toHaveValue('2026-10-04');
    }
  });
}

test('la build conserva las rutas de Pages y las landings indexables', async ({ request }) => {
  const routes = JSON.parse(readFileSync(new URL('../dist/_routes.json', import.meta.url), 'utf8'));
  expect(routes).toEqual({ version: 1, include: ['/', '/api/contacto'], exclude: [] });
  for (const path of ['/agenda/gratis/', '/agenda/fin-de-semana/']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toMatch(/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/);
  }
});
