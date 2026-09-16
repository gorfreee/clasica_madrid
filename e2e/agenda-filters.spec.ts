import { expect, test, type Page } from '@playwright/test';

type Box = { x: number; y: number; width: number; height: number };

const VIEWPORTS = [
  { name: 'escritorio', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'móvil', width: 390, height: 844 },
] as const;

function toggle(page: Page) {
  return page.getByRole('button', { name: 'Filtros' });
}

function panel(page: Page) {
  return page.locator('[data-advanced-filters-panel]');
}

function applyInPanel(page: Page) {
  return panel(page).getByRole('button', { name: 'Aplicar filtros' });
}

function toolbarGeometry(page: Page) {
  return page.evaluate(() => {
    const round = (rect: DOMRect): Box => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const toolbar = document.querySelector<HTMLElement>('.filters__toolbar');
    const toggleEl = document.querySelector<HTMLElement>('[data-advanced-filters-toggle]');
    const shortcuts = document.querySelector<HTMLElement>('[data-agenda-shortcuts]');
    const count = document.querySelector<HTMLElement>('[data-result-count]');
    const panelEl = document.querySelector<HTMLElement>('[data-advanced-filters-panel]');
    const form = document.querySelector<HTMLElement>('[data-agenda-filters]');
    if (!toolbar || !toggleEl || !shortcuts || !count || !panelEl || !form) {
      throw new Error('missing filter toolbar markup');
    }
    return {
      structure: {
        toggleInToolbar: toolbar.contains(toggleEl),
        panelInToolbar: toolbar.contains(panelEl),
        panelAfterToolbar: toolbar.nextElementSibling === panelEl,
        toggleOrder: getComputedStyle(toggleEl).order,
        panelOrder: getComputedStyle(panelEl).order,
      },
      toolbar: round(toolbar.getBoundingClientRect()),
      toggle: round(toggleEl.getBoundingClientRect()),
      shortcuts: round(shortcuts.getBoundingClientRect()),
      count: round(count.getBoundingClientRect()),
      panel: round(panelEl.getBoundingClientRect()),
      form: round(form.getBoundingClientRect()),
      overflow: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  });
}

function expectUnmoved(label: string, before: Box, after: Box) {
  expect(Math.abs(after.x - before.x), `${label} x`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y), `${label} y`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.width - before.width), `${label} width`).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height), `${label} height`).toBeLessThanOrEqual(1);
}

test.describe('filtros avanzados de la agenda', () => {
  test('el panel empieza cerrado y el botón controla visibilidad y aria-expanded', async ({ page }) => {
    await page.goto('/');
    const button = toggle(page);
    const advanced = panel(page);

    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toHaveAttribute('aria-controls', 'agenda-advanced-filters');
    await expect(advanced).toBeHidden();
    await expect(page.locator('[data-advanced-filters-panel] input[name="from"]')).toBeHidden();

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(advanced).toBeVisible();
    await expect(page.locator('[data-advanced-filters-panel] input[name="from"]')).toBeVisible();
    await expect(applyInPanel(page)).toBeVisible();

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(advanced).toBeHidden();
    await expect(page.locator('[data-advanced-filters-panel] input[name="from"]')).toBeHidden();
  });

  test('el botón es operable por teclado y el panel oculto no recibe foco', async ({ page }) => {
    await page.goto('/');
    const button = toggle(page);
    await button.focus();
    await expect(button).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page)).toBeVisible();

    await page.locator('[data-advanced-filters-panel] input[name="from"]').focus();
    await expect(page.locator('[data-advanced-filters-panel] input[name="from"]')).toBeFocused();

    await button.focus();
    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('[data-advanced-filters-panel] input[name="from"]')).toBeHidden();
  });

  test('aplicar un filtro desde el panel actualiza la agenda', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-agenda-list] [data-occurrence-id]').first()).toBeVisible();
    const initialCount = await page
      .locator('[data-agenda-list] [data-occurrence-id]')
      .filter({ visible: true })
      .count();

    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await page.locator('[data-advanced-filters-panel] select[name="access"]').selectOption('free');
    await applyInPanel(page).click();

    await expect(page).toHaveURL(/access=free/);
    await expect(page.locator('[data-agenda-filters] select[name="access"]')).toHaveValue('free');
    await expect(page.locator('[data-clear-filters]')).toBeVisible();
    const filteredCount = await page
      .locator('[data-agenda-list] [data-occurrence-id]')
      .filter({ visible: true })
      .count();
    expect(filteredCount).toBeGreaterThan(0);
    expect(filteredCount).toBeLessThanOrEqual(initialCount);
    await expect(page.locator('[data-active-filters] [data-remove-filter="access"]')).toBeVisible();
  });

  for (const viewport of VIEWPORTS) {
    test(`abrir filtros no mueve la toolbar en ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);

      const before = await toolbarGeometry(page);
      expect(before.structure.toggleInToolbar).toBe(true);
      expect(before.structure.panelInToolbar).toBe(false);
      expect(before.structure.panelAfterToolbar).toBe(true);
      expect(before.structure.toggleOrder).toBe('0');
      expect(before.overflow.scrollWidth).toBe(before.overflow.clientWidth);

      await toggle(page).click();
      await expect(panel(page)).toBeVisible();

      const after = await toolbarGeometry(page);
      expect(after.structure.toggleInToolbar).toBe(true);
      expect(after.structure.panelInToolbar).toBe(false);
      expect(after.structure.panelAfterToolbar).toBe(true);
      expect(after.structure.toggleOrder).toBe('0');
      expectUnmoved('toggle', before.toggle, after.toggle);
      expectUnmoved('shortcuts', before.shortcuts, after.shortcuts);
      expectUnmoved('count', before.count, after.count);
      expectUnmoved('toolbar', before.toolbar, after.toolbar);
      expect(after.panel.y).toBeGreaterThanOrEqual(after.toolbar.y + after.toolbar.height - 1);
      expect(after.panel.x).toBeGreaterThanOrEqual(after.form.x - 1);
      expect(after.panel.x + after.panel.width).toBeLessThanOrEqual(after.form.x + after.form.width + 1);
      expect(after.overflow.scrollWidth).toBe(after.overflow.clientWidth);

      if (viewport.width <= 620) {
        const applyBox = await applyInPanel(page).boundingBox();
        expect(applyBox).not.toBeNull();
        expect(applyBox!.width).toBeGreaterThan(after.form.width * 0.7);
      }
    });
  }
});
