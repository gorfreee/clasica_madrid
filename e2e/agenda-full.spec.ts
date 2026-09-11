import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
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
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();

    await page.goto('/?access=free');
    await expect(visibleOccurrences(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-filters] select[name="access"]')).toHaveValue('free');
    await expect(page.locator('[data-result-count]')).toBeVisible();
    const sample = Math.min(await visibleOccurrences(page).count(), 8);
    for (let index = 0; index < sample; index += 1) {
      await expect(visibleOccurrences(page).nth(index).getByText('Gratis', { exact: true })).toBeVisible();
    }

    await page.locator('[data-clear-filters]').click();
    await expect(page).toHaveURL('/');
    expect(await visibleOccurrences(page).count()).toBe(initialCount);
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeVisible();
  });

  test('limpiar filtros restaura el recorte inicial y «Mostrar todos»', async ({ page }) => {
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeVisible();
    await expect(page.locator('[data-agenda-showing]')).toBeVisible();

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill('Bach');
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page).toHaveURL(/\?q=/);
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);

    await page.locator('[data-clear-filters]').click();
    await expect(page).toHaveURL('/');
    expect(await visibleOccurrences(page).count()).toBe(initialCount);
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeEnabled();
    await expect(page.locator('[data-agenda-showing]')).toBeVisible();
  });

  test('tras restaurar el recorte, «Mostrar todos» expande sin volver a descargar', async ({ page }) => {
    let fragmentRequests = 0;
    await page.route(isFullAgendaUrl, async (route) => {
      fragmentRequests += 1;
      await route.continue();
    });
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill('Bach');
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page).toHaveURL(/\?q=/);
    await page.locator('[data-clear-filters]').click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeVisible();
    expect(fragmentRequests).toBe(1);

    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    expect(await visibleOccurrences(page).count()).toBeGreaterThan(initialCount);
    expect(fragmentRequests).toBe(1);
  });

  test('si el usuario ya expandió, limpiar filtros no vuelve a recortar', async ({ page }) => {
    await page.goto('/');
    const initialCount = await visibleOccurrences(page).count();
    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    const expandedCount = await visibleOccurrences(page).count();
    expect(expandedCount).toBeGreaterThan(initialCount);

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill('Bach');
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page).toHaveURL(/\?q=/);

    await page.locator('[data-clear-filters]').click();
    await expect(page).toHaveURL('/');
    expect(await visibleOccurrences(page).count()).toBe(expandedCount);
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
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
    await expect(page.locator('.site-mark [data-brand-symbol]')).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { __agendaStay?: boolean }).__agendaStay = true;
    });
    await page.getByRole('link', { name: 'Clásica Madrid, ir al comienzo' }).click();
    await expect(page).toHaveURL(/#top$/);
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Agenda' }).click();
    await expect(page).toHaveURL(/#contenido$/);
    expect(await page.evaluate(() => (window as Window & { __agendaStay?: boolean }).__agendaStay)).toBe(true);
  });

  test('publica el favicon vectorial y su fallback', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="icon"][href="/favicon.svg"]')).toHaveCount(1);
    await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
    expect((await request.get('/favicon.svg')).ok()).toBe(true);
    expect((await request.get('/favicon.ico')).ok()).toBe(true);
  });

  test('publica social sharing e identidad desde el HTML generado', async ({ page, request }) => {
    await page.goto('/');

    const socialImage = 'https://clasicamadrid.com/brand/clasica-madrid-social-card.png';
    const socialAlt = 'Clásica Madrid — Agenda de música clásica en Madrid';
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', socialImage);
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
    await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute('content', 'image/png');
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', socialAlt);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute('content', socialImage);
    await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute('content', socialAlt);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0055A0');
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/site.webmanifest');

    for (const asset of [
      '/brand/clasica-madrid-social-card.png',
      '/apple-touch-icon.png',
      '/site.webmanifest',
      '/brand/clasica-madrid-icon-192.png',
      '/brand/clasica-madrid-icon-512.png',
    ]) {
      expect((await request.get(asset)).ok(), asset).toBe(true);
    }

    const eventHref = await page
      .locator('[data-agenda-list] [data-occurrence-id] h3 a')
      .first()
      .getAttribute('href');
    expect(eventHref).toBeTruthy();
    await page.goto(eventHref!);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', socialImage);
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

  test('en escritorio Agenda y Lugares están a la vista y Más abre Acerca de', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    const more = nav.getByRole('button', { name: 'Más' });
    await expect(nav.getByRole('link', { name: 'Agenda' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Lugares' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Agenda' })).toHaveAttribute('aria-current', 'page');
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).not.toHaveAttribute('aria-current');
    await expect(nav.getByRole('button', { name: 'Menú de secciones' })).toHaveCount(0);

    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Acerca de' })).toBeVisible();

    await page.goto('/lugares/');
    await expect(nav.getByRole('link', { name: 'Lugares' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Agenda' })).not.toHaveAttribute('aria-current');
    await expect(nav.getByRole('button', { name: 'Más' })).not.toHaveAttribute('aria-current');
  });

  test('en escritorio Más lleva a Acerca de y marca la sección activa', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await nav.getByRole('button', { name: 'Más' }).click();
    await nav.getByRole('link', { name: 'Acerca de' }).click();
    await expect(page).toHaveURL('/acerca-de/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Más' })).toHaveAttribute('aria-current', 'true');
    await expect(nav.getByRole('link', { name: 'Agenda' })).not.toHaveAttribute('aria-current');
  });

  test('en móvil Agenda permanece visible y Lugares está en el menú', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    const menu = nav.getByRole('button', { name: 'Menú de secciones' });

    await expect(nav.getByRole('link', { name: 'Agenda' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Lugares' })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: 'Lugares' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Acerca de' })).toBeVisible();

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Lugares' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Acerca de' })).toHaveCount(0);
  });

  test('el menú móvil se cierra con Escape y al pulsar fuera', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    const menu = nav.getByRole('button', { name: 'Menú de secciones' });

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeFocused();

    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('heading', { level: 1 }).click();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  test('elegir Lugares en el menú móvil navega al índice', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await nav.getByRole('button', { name: 'Menú de secciones' }).click();
    await nav.getByRole('link', { name: 'Lugares' }).click();
    await expect(page).toHaveURL('/lugares/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('en una ficha de lugar el menú móvil marca Lugares como página activa', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/lugares/');
    const nav = page.getByRole('navigation', { name: 'Principal' });
    const menu = nav.getByRole('button', { name: 'Menú de secciones' });
    await expect(nav.getByRole('link', { name: 'Agenda' })).not.toHaveAttribute('aria-current');
    await menu.click();
    await expect(nav.getByRole('link', { name: 'Lugares' })).toHaveAttribute('aria-current', 'page');
  });

  test('no desborda en móvil estrecho con la cabecera compacta', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBe(layout.clientWidth);
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByRole('link', { name: 'Agenda' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Menú de secciones' })).toBeVisible();
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
