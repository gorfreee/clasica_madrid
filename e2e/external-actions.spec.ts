import { expect, test } from '@playwright/test';

test.describe('acciones externas', () => {
  test('la ficha de evento enlaza la fuente principal sin sustituir Fuentes', async ({ page }) => {
    await page.goto('/');
    const item = page.locator('[data-agenda-list] [data-occurrence-id]').filter({ visible: true }).first();
    await expect(item).toBeVisible();
    await item.getByRole('heading', { level: 3 }).getByRole('link').click();

    const action = page.getByRole('link', {
      name: /Entradas e información oficial|Ver fuente original/,
    });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('target', '_blank');
    await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
    await action.focus();
    await expect(action).toBeFocused();

    const label = (await action.getAttribute('aria-label')) ?? '';
    if (label.includes('información oficial')) {
      expect(label).toContain('Entradas e información oficial');
    } else {
      expect(label).toContain('Ver fuente original');
      expect(label.toLowerCase()).not.toContain('oficial');
    }

    await expect(page.getByRole('heading', { name: 'Fuentes', level: 2 })).toBeVisible();
    await expect(
      page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Fuentes', level: 2 }) })
        .getByRole('link')
        .first(),
    ).toBeVisible();
  });

  test('la ficha de lugar con web muestra Web oficial junto a la dirección', async ({ page }) => {
    await page.goto('/lugares/teatro-real/');

    const officialWeb = page.getByRole('link', { name: /Web oficial/ });
    await expect(officialWeb).toBeVisible();
    await expect(officialWeb).toHaveAttribute('href', 'https://www.teatroreal.es/es');
    await expect(officialWeb).toHaveAttribute('target', '_blank');
    await expect(officialWeb).toHaveAttribute('rel', 'noopener noreferrer');
    await officialWeb.focus();
    await expect(officialWeb).toBeFocused();

    await expect(page.getByRole('link', { name: /Ver .* en Google Maps/ })).toBeVisible();
  });

  test('un lugar sin URL no muestra Web oficial', async ({ page }) => {
    await page.goto('/lugares/real-monasterio-de-santa-isabel/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real Monasterio de Santa Isabel');
    await expect(page.getByRole('link', { name: /Web oficial/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Ver .* en Google Maps/ })).toBeVisible();
  });
});
