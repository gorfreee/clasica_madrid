import { expect, test, type Page } from '@playwright/test';

function visibleVenues(page: Page) {
  return page.locator('[data-venue-entry]').filter({ visible: true });
}

test.describe('búsqueda de lugares', () => {
  test('filtra por nombre, municipio y acentos, actualiza el contador y se limpia', async ({ page }) => {
    await page.goto('/lugares/');
    const search = page.getByRole('searchbox', { name: 'Buscar un lugar' });
    await expect(search).toHaveAttribute('type', 'search');
    await expect(search).toHaveAttribute('placeholder', 'Busca un lugar o municipio');
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeHidden();

    const initialCount = await visibleVenues(page).count();
    expect(initialCount).toBeGreaterThan(1);
    await expect(page.locator('[data-venue-count]')).toHaveText(`${initialCount} lugares`);

    await search.fill('teatro real');
    await expect(visibleVenues(page).getByText('Teatro Real', { exact: true })).toBeVisible();
    const afterName = await visibleVenues(page).count();
    expect(afterName).toBeGreaterThan(0);
    expect(afterName).toBeLessThan(initialCount);
    await expect(page.locator('[data-venue-count]')).toHaveText(
      afterName === 1 ? '1 lugar' : `${afterName} lugares`,
    );
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeVisible();

    await search.fill('getafe');
    const afterMunicipality = await visibleVenues(page).count();
    expect(afterMunicipality).toBeGreaterThan(0);
    expect(afterMunicipality).toBeLessThan(initialCount);
    const municipalities = await visibleVenues(page).locator('.venue-list__municipality').allTextContents();
    expect(municipalities).toHaveLength(afterMunicipality);
    expect(municipalities.every((municipality) => municipality === 'Getafe')).toBe(true);
    await expect(page.locator('[data-venue-count]')).toHaveText(
      afterMunicipality === 1 ? '1 lugar' : `${afterMunicipality} lugares`,
    );
    await expect(page.locator('[data-venue-no-results]')).toBeHidden();

    await search.fill('basilica');
    await expect(page.getByRole('link', { name: 'Basílica Pontificia de San Miguel' })).toBeVisible();
    await expect(visibleVenues(page).getByText('Teatro Real', { exact: true })).toHaveCount(0);

    await search.fill('chamberí xyz');
    await expect(visibleVenues(page)).toHaveCount(0);
    await expect(page.locator('[data-venue-list]')).toBeHidden();
    await expect(page.locator('[data-venue-count]')).toBeHidden();
    await expect(page.locator('[data-venue-no-results]')).toHaveText(
      'No encontramos ningún lugar para “chamberí xyz”',
    );

    await page.getByRole('button', { name: 'Limpiar búsqueda' }).click();
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(visibleVenues(page)).toHaveCount(initialCount);
    await expect(page.locator('[data-venue-list]')).toBeVisible();
    await expect(page.locator('[data-venue-count]')).toHaveText(`${initialCount} lugares`);
    await expect(page.locator('[data-venue-no-results]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeHidden();
  });

  test('en móvil no desborda y sigue filtrando al escribir', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/lugares/');

    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBe(layout.clientWidth);

    const search = page.getByRole('searchbox', { name: 'Buscar un lugar' });
    await expect(search).toBeVisible();
    await search.fill('basilica');
    await expect(page.getByRole('link', { name: 'Basílica Pontificia de San Miguel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar búsqueda' })).toBeVisible();
  });
});
