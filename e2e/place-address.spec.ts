import { expect, test } from '@playwright/test';

test.describe('ubicaciones enlazables', () => {
  test('la ficha de lugar abre la ubicación en Google Maps sin CTA de Cómo llegar', async ({ page }) => {
    await page.goto('/lugares/teatro-real/');

    const maps = page.getByRole('link', { name: /Ver .* en Google Maps/ });
    await expect(maps).toBeVisible();
    await expect(maps).toHaveAttribute(
      'href',
      /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/,
    );
    await expect(maps).toHaveAttribute('target', '_blank');
    await expect(maps).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByText('Cómo llegar', { exact: true })).toHaveCount(0);
  });
});
