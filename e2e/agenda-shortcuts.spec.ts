import { expect, test, type Page } from '@playwright/test';
import { madridWeekendRange } from '../src/lib/domain/dates.ts';

function shortcut(page: Page, id: 'weekend' | 'free') {
  return page.locator(`[data-agenda-shortcut="${id}"]`);
}

function searchParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

async function expectPressed(page: Page, id: 'weekend' | 'free', pressed: boolean) {
  await expect(shortcut(page, id)).toHaveAttribute('aria-pressed', pressed ? 'true' : 'false');
}

test.describe('atajos rápidos de la agenda', () => {
  test('Gratis y Fin de semana siguen siendo filtros de la home, no landings SEO', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto('/');
    await expect(shortcut(page, 'free')).toHaveAttribute('href', '/?access=free');
    await expect(shortcut(page, 'weekend')).toHaveAttribute(
      'href',
      `/?from=${weekend.from}&to=${weekend.to}`,
    );
    expect(await shortcut(page, 'free').getAttribute('href')).not.toContain('/agenda/');
    expect(await shortcut(page, 'weekend').getAttribute('href')).not.toContain('/agenda/');
  });

  test('activar Fin de semana conserva los filtros existentes y se puede desactivar', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto('/?q=bach&access=free');
    await expect(shortcut(page, 'free')).toHaveAttribute('aria-pressed', 'true');
    await expectPressed(page, 'weekend', false);

    await shortcut(page, 'weekend').click();
    await expect(page).toHaveURL(new RegExp(`[?&]q=bach`));
    expect(searchParams(page).get('q')).toBe('bach');
    expect(searchParams(page).get('access')).toBe('free');
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).get('to')).toBe(weekend.to);
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', true);
    await expect(page.locator('[data-active-filters] [data-remove-filter="from,to"]')).toContainText('Fin de semana');
    await expect(page.locator('[data-active-filters] [data-remove-filter="from"]')).toHaveCount(0);
    await expect(page.locator('[data-active-filters] [data-remove-filter="to"]')).toHaveCount(0);

    await shortcut(page, 'weekend').click();
    await expect(page).toHaveURL(/q=bach/);
    expect(searchParams(page).get('q')).toBe('bach');
    expect(searchParams(page).get('access')).toBe('free');
    expect(searchParams(page).has('from')).toBe(false);
    expect(searchParams(page).has('to')).toBe(false);
    await expectPressed(page, 'weekend', false);
    await expectPressed(page, 'free', true);
  });

  test('activar y desactivar Gratis conserva Fin de semana y el resto de filtros', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto(`/?q=bach&from=${weekend.from}&to=${weekend.to}`);
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', false);

    await shortcut(page, 'free').click();
    await expect(page).toHaveURL(/access=free/);
    expect(searchParams(page).get('q')).toBe('bach');
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).get('to')).toBe(weekend.to);
    expect(searchParams(page).get('access')).toBe('free');
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', true);

    await shortcut(page, 'free').click();
    await expect(page).not.toHaveURL(/access=/);
    expect(searchParams(page).get('q')).toBe('bach');
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).get('to')).toBe(weekend.to);
    expect(searchParams(page).has('access')).toBe(false);
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', false);
  });

  test('un rango manual distinto no marca Fin de semana y al pulsarlo solo sustituye from/to', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto('/?q=bach&from=2026-09-10&to=2026-09-30');
    await expectPressed(page, 'weekend', false);
    await expect(page.locator('[data-active-filters] [data-remove-filter="from"]')).toBeVisible();
    await expect(page.locator('[data-active-filters] [data-remove-filter="to"]')).toBeVisible();

    await shortcut(page, 'weekend').click();
    await expect(page).toHaveURL(new RegExp(`from=${weekend.from}`));
    expect(searchParams(page).get('q')).toBe('bach');
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).get('to')).toBe(weekend.to);
    await expectPressed(page, 'weekend', true);
    await expect(page.locator('[data-active-filters] [data-remove-filter="from,to"]')).toContainText('Fin de semana');
  });

  test('atrás y adelante restauran URL y estado visual de los atajos', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto('/');
    await expect(visibleFirst(page)).toBeVisible();
    await shortcut(page, 'weekend').click();
    await expect(page).toHaveURL(new RegExp(`from=${weekend.from}`));
    await expectPressed(page, 'weekend', true);

    await shortcut(page, 'free').click();
    await expect(page).toHaveURL(/access=free/);
    expect(searchParams(page).get('access')).toBe('free');
    await expectPressed(page, 'free', true);
    await expectPressed(page, 'weekend', true);

    await page.goBack();
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).has('access')).toBe(false);
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', false);

    await page.goBack();
    await expect(page).toHaveURL('/');
    await expectPressed(page, 'weekend', false);
    await expectPressed(page, 'free', false);

    await page.goForward();
    await expectPressed(page, 'weekend', true);
    await expectPressed(page, 'free', false);
  });

  test('el clic recalcula el fin de semana con la fecha actual y no recarga el documento', async ({ page }) => {
    const weekend = madridWeekendRange();
    await page.goto('/');
    await page.evaluate(() => {
      (window as Window & { __agendaStay?: boolean }).__agendaStay = true;
    });
    await shortcut(page, 'weekend').evaluate((link, stale) => {
      link.setAttribute('href', `/?from=${stale}&to=${stale}`);
    }, '2020-01-01');
    await shortcut(page, 'weekend').click();
    await expect(page).toHaveURL(new RegExp(`from=${weekend.from}`));
    expect(searchParams(page).get('from')).toBe(weekend.from);
    expect(searchParams(page).get('to')).toBe(weekend.to);
    expect(searchParams(page).get('from')).not.toBe('2020-01-01');
    expect(await page.evaluate(() => (window as Window & { __agendaStay?: boolean }).__agendaStay)).toBe(true);
    await expectPressed(page, 'weekend', true);
  });
});

function visibleFirst(page: Page) {
  return page.locator('[data-agenda-list] [data-occurrence-id]').filter({ visible: true }).first();
}
