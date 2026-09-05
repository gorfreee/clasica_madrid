import { expect, test, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { INITIAL_AGENDA_OCCURRENCE_LIMIT } from '../src/lib/presentation/agenda.ts';
import { FULL_AGENDA_FRAGMENT_PATH } from '../src/lib/presentation/urls.ts';

function visibleOccurrences(page: Page) {
  return page.locator('[data-agenda-list] [data-occurrence-id]').filter({ visible: true });
}

function occurrenceIds(html: string): string[] {
  return [...html.matchAll(/data-occurrence-id="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function isFullAgendaUrl(url: URL): boolean {
  return url.pathname.replace(/\/$/, '') === FULL_AGENDA_FRAGMENT_PATH.replace(/\/$/, '');
}

test.describe('carga diferida de la agenda', () => {
  test('el HTML generado de la portada sólo incluye el subconjunto inicial', () => {
    const indexHtml = readFileSync('dist/index.html', 'utf8');
    const fullHtml = readFileSync('dist/_agenda/completa/index.html', 'utf8');
    const initialIds = occurrenceIds(indexHtml);
    const fullIds = occurrenceIds(fullHtml);
    expect(fullIds.length).toBeGreaterThan(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(initialIds.length).toBeGreaterThanOrEqual(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    expect(initialIds.length).toBeLessThan(fullIds.length);
    const extraIds = fullIds.filter((id) => !initialIds.includes(id));
    expect(extraIds.length).toBeGreaterThan(0);
    for (const id of extraIds) {
      expect(indexHtml).not.toContain(`data-occurrence-id="${id}"`);
    }
    const indexJson = indexHtml.match(/id="agenda-filter-data"[^>]*>(.*?)<\/script>/)?.[1] ?? '';
    const fullJson = fullHtml.match(/id="agenda-filter-data"[^>]*>(.*?)<\/script>/)?.[1] ?? '';
    expect(indexJson.length).toBeGreaterThan(0);
    expect(fullJson.length).toBeGreaterThan(indexJson.length);
  });

  test('«Mostrar todos» carga la agenda completa una vez y desaparece', async ({ page }) => {
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeVisible();
    await expect(page.locator('[data-agenda-showing]')).toBeVisible();

    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    const fullCount = await visibleOccurrences(page).count();
    expect(fullCount).toBeGreaterThan(initialCount);
  });

  test('aplicar un filtro carga antes la agenda completa y puede encontrar una representación posterior', async ({
    page,
  }) => {
    const extraId = occurrenceIds(readFileSync('dist/_agenda/completa/index.html', 'utf8')).find(
      (id) => !occurrenceIds(readFileSync('dist/index.html', 'utf8')).includes(id),
    );
    expect(extraId).toBeTruthy();
    await page.goto(FULL_AGENDA_FRAGMENT_PATH);
    const title = (await page.locator(`[data-occurrence-id="${extraId}"] h3 a`).innerText()).trim();
    expect(title.length).toBeGreaterThan(0);

    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();
    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill(title);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();

    await expect(page).toHaveURL(/\?q=/);
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator(`[data-occurrence-id="${extraId}"]`)).toBeVisible();
    const visible = await visibleOccurrences(page).count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(initialCount);
  });

  test('una URL filtrada abierta directamente carga y filtra todo el catálogo', async ({ page }) => {
    await page.goto('/?access=free');
    await expect(visibleOccurrences(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-filters] select[name="access"]')).toHaveValue('free');
    await expect(page.locator('[data-result-count]')).toBeVisible();
    const sample = Math.min(await visibleOccurrences(page).count(), 8);
    for (let index = 0; index < sample; index += 1) {
      await expect(visibleOccurrences(page).nth(index).locator('.signal-free')).toBeVisible();
    }
  });

  test('los accesos rápidos siguen funcionando sin recargar', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      (window as Window & { __agendaStay?: boolean }).__agendaStay = true;
    });
    await page.getByRole('navigation', { name: 'Accesos rápidos de agenda' }).getByRole('link', { name: 'Gratis' }).click();
    await expect(page).toHaveURL(/access=free/);
    expect(await page.evaluate(() => (window as Window & { __agendaStay?: boolean }).__agendaStay)).toBe(true);
    await expect(visibleOccurrences(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
  });

  test('varias acciones simultáneas no duplican la descarga del fragmento', async ({ page }) => {
    let fragmentRequests = 0;
    await page.route(isFullAgendaUrl, async (route) => {
      fragmentRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.goto('/');
    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill('Bach');
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-load-full-agenda]')?.click();
      document.querySelector<HTMLFormElement>('[data-agenda-filters]')?.requestSubmit();
    });
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    expect(fragmentRequests).toBe(1);
  });

  test('un fallo de descarga conserva la agenda inicial y permite reintentar', async ({ page }) => {
    let attempts = 0;
    await page.route(isFullAgendaUrl, async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();
    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeEnabled();
    await expect(page.locator('[data-agenda-root]')).not.toHaveAttribute('aria-busy');
    expect(await visibleOccurrences(page).count()).toBe(initialCount);

    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    expect(await visibleOccurrences(page).count()).toBeGreaterThan(initialCount);
  });
});

test.describe('navegación del encabezado', () => {
  test('en la portada el logo y Agenda no recargan el documento', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      (window as Window & { __agendaStay?: boolean }).__agendaStay = true;
    });
    await page.getByRole('link', { name: 'Clásica Madrid, ir al comienzo' }).click();
    await expect(page).toHaveURL(/#top$/);
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Agenda' }).click();
    await expect(page).toHaveURL(/#contenido$/);
    expect(await page.evaluate(() => (window as Window & { __agendaStay?: boolean }).__agendaStay)).toBe(true);
  });

  test('desde otras rutas el logo y Agenda llevan a la portada', async ({ page }) => {
    await page.goto('/lugares/');
    await page.getByRole('link', { name: 'Clásica Madrid, ir a la agenda' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.goto('/lugares/');
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Agenda' }).click();
    await expect(page).toHaveURL('/');
  });
});

test.describe('sitemap interno', () => {
  test('la ruta de la agenda completa no aparece en el sitemap', async ({ request }) => {
    const index = await request.get('/sitemap-index.xml');
    expect(index.ok()).toBe(true);
    const indexXml = await index.text();
    expect(indexXml).not.toContain('/_agenda');
    const loc = indexXml.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (loc) {
      const sitemap = await request.get(loc);
      expect(await sitemap.text()).not.toContain('/_agenda');
    }
  });
});

test.describe('tamaño de artefactos', () => {
  test('informa del tamaño de la portada y del fragmento completo', () => {
    const indexSize = statSync('dist/index.html').size;
    const fullSize = statSync('dist/_agenda/completa/index.html').size;
    const indexIds = occurrenceIds(readFileSync('dist/index.html', 'utf8')).length;
    const fullIds = occurrenceIds(readFileSync('dist/_agenda/completa/index.html', 'utf8')).length;
    expect(indexSize).toBeLessThan(fullSize);
    expect(indexIds).toBeLessThan(fullIds);
    expect(fullIds).toBeGreaterThan(INITIAL_AGENDA_OCCURRENCE_LIMIT);
    console.log(
      JSON.stringify({
        previousIndexBytes: 1_250_179,
        previousIndexOccurrences: 695,
        indexBytes: indexSize,
        indexOccurrences: indexIds,
        fullFragmentBytes: fullSize,
        fullFragmentOccurrences: fullIds,
      }),
    );
  });
});
