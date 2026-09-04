import { expect, test, type Page } from '@playwright/test';

/**
 * UI smoke tests for the published agenda.
 *
 * They lock behaviour and the internal `data-*` contract used by
 * `src/lib/presentation/agenda-client.ts`, not CSS classes or copy
 * that a visual redesign may change.
 *
 * Assumes the published catalog has upcoming occurrences (true for
 * production CI). An empty catalog is valid for the data layer, but
 * these smokes would then fail on purpose.
 */

const NO_MATCH_QUERY = '__no_such_concert__';

function visibleOccurrences(page: Page) {
  return page.locator('[data-agenda-list] [data-occurrence-id]').filter({ visible: true });
}

test.describe('agenda', () => {
  test('la portada carga y muestra representaciones próximas', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-agenda-filters]')).toBeVisible();
    await expect(page.locator('[data-agenda-list]')).toBeVisible();
    await expect(visibleOccurrences(page).first()).toBeVisible();
    await expect(page.locator('[data-result-count]')).toBeVisible();
    await expect(page.locator('[data-no-results]')).toBeHidden();
  });

  test('aplicar un filtro de búsqueda actualiza la agenda en el cliente', async ({ page }) => {
    await page.goto('/');
    await expect(visibleOccurrences(page).first()).toBeVisible();
    const initialCount = await visibleOccurrences(page).count();

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill(NO_MATCH_QUERY);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();

    await expect(page).toHaveURL(new RegExp(`[?&]q=${NO_MATCH_QUERY}`));
    await expect(page.locator('[data-no-results]')).toBeVisible();
    await expect(visibleOccurrences(page)).toHaveCount(0);
    await expect(page.locator('[data-result-count]')).toBeHidden();
    await expect(page.locator('[data-clear-filters]')).toBeVisible();
    expect(initialCount).toBeGreaterThan(0);
  });

  test('quitar filtros restaura la agenda sin filtrar', async ({ page }) => {
    await page.goto('/');
    await expect(visibleOccurrences(page).first()).toBeVisible();
    const initialCount = await visibleOccurrences(page).count();
    const initialLabel = await page.locator('[data-result-count]').innerText();

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill(NO_MATCH_QUERY);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page.locator('[data-no-results]')).toBeVisible();

    await page.locator('[data-clear-filters]').click();

    await expect(page).toHaveURL('/');
    await expect(visibleOccurrences(page)).toHaveCount(initialCount);
    await expect(page.locator('[data-result-count]')).toHaveText(initialLabel);
    await expect(page.locator('[data-no-results]')).toBeHidden();
    await expect(page.locator('[data-clear-filters]')).toBeHidden();
    await expect(form.getByRole('searchbox')).toHaveValue('');
  });

  test('atrás del navegador restaura la agenda vía popstate', async ({ page }) => {
    await page.goto('/');
    await expect(visibleOccurrences(page).first()).toBeVisible();
    const initialCount = await visibleOccurrences(page).count();

    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill(NO_MATCH_QUERY);
    await form.getByRole('button', { name: 'Aplicar filtros' }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=${NO_MATCH_QUERY}`));
    await expect(visibleOccurrences(page)).toHaveCount(0);

    await page.goBack();

    await expect(page).toHaveURL('/');
    await expect(visibleOccurrences(page)).toHaveCount(initialCount);
    await expect(page.locator('[data-no-results]')).toBeHidden();
    await expect(form.getByRole('searchbox')).toHaveValue('');
  });

  test('un slug histórico de sala filtra el lugar principal y marca esa opción', async ({ page }) => {
    await page.goto('/?venue=auditorio-nacional-sala-sinfonica');
    await expect(visibleOccurrences(page).first()).toBeVisible();

    const venueSelect = page.locator('[data-agenda-filters] select[name="venue"]');
    await expect(venueSelect).toHaveValue('auditorio-nacional-de-musica');
    await expect(page.locator('[data-active-filters] [data-remove-filter="venue"]')).toContainText(
      'Auditorio Nacional de Música',
    );

    const items = visibleOccurrences(page);
    await expect(items.first().getByRole('link').nth(1)).toHaveText('Auditorio Nacional de Música');
    const sample = Math.min(await items.count(), 12);
    for (let index = 0; index < sample; index += 1) {
      await expect(items.nth(index).getByRole('link').nth(1)).toHaveText('Auditorio Nacional de Música');
      await expect(items.nth(index).getByRole('link').nth(1)).not.toHaveText(/Sala Sinfónica/);
    }
    await expect(page.locator('[data-result-count]')).toBeVisible();
  });
});

test.describe('ficha de evento', () => {
  test('una representación de la agenda abre una ficha con la información esencial', async ({ page }) => {
    await page.goto('/');
    const item = visibleOccurrences(page).first();
    await expect(item).toBeVisible();

    const titleLink = item.getByRole('heading', { level: 3 }).getByRole('link');
    const title = (await titleLink.innerText()).trim();
    const href = await titleLink.getAttribute('href');
    expect(href).toMatch(/^\/eventos\//);

    const venueName = (await item.getByRole('link').nth(1).innerText()).trim();
    await titleLink.click();

    await expect(page).toHaveURL(href!);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    // Venue and source can share a name (e.g. Teatro La Latina). The place
    // link is the internal /lugares/ one, not the citation in Fuentes.
    await expect(
      page.getByRole('link', { name: venueName, exact: true }).and(page.locator('[href^="/lugares/"]')),
    ).toBeVisible();
    await expect(page.locator('dt', { hasText: 'Acceso' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fechas', level: 2 })).toBeVisible();
    await expect(
      page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Fechas', level: 2 }) })
        .getByRole('listitem')
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fuentes', level: 2 })).toBeVisible();
    await expect(
      page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Fuentes', level: 2 }) })
        .getByRole('link')
        .first(),
    ).toBeVisible();
  });
});
