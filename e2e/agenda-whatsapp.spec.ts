import { expect, test, type Page } from '@playwright/test';
import { WHATSAPP_CHANNEL_URL } from '../src/lib/presentation/constants.ts';

type AnalyticsCall = { event: string; properties: Record<string, unknown> };

const CHANNEL_NAME = /Seguir el canal de Clásica Madrid en WhatsApp \(se abre en otra pestaña\)/;

async function installAnalytics(page: Page) {
  await page.addInitScript(() => {
    const calls: AnalyticsCall[] = [];
    (window as unknown as { __analytics: AnalyticsCall[] }).__analytics = calls;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      value: {
        capture(event: string, properties: Record<string, unknown>) {
          calls.push({ event, properties: { ...properties } });
        },
      },
    });
  });
}

async function analyticsCalls(page: Page): Promise<AnalyticsCall[]> {
  return page.evaluate(() => (window as unknown as { __analytics: AnalyticsCall[] }).__analytics);
}

/**
 * Same complete-day rule as `agendaInlineChannelBreak`. Kept here so the
 * smoke checks the rendered list instead of trusting the helper alone.
 */
function expectedBreakCount(dayCounts: number[]): number | null {
  const cumulative: number[] = [];
  let total = 0;
  for (const count of dayCounts) {
    total += count;
    cumulative.push(total);
  }
  const boundaries = cumulative
    .slice(0, -1)
    .filter((count) => count > 0 && total > count);
  const inBand = boundaries.filter((count) => count >= 8 && count <= 12);
  const pool = inBand.length > 0 ? inBand : boundaries.filter((count) => count >= 8);
  if (pool.length === 0) return null;
  return pool.reduce((best, count) => {
    if (Math.abs(count - 10) < Math.abs(best - 10)) return count;
    return best;
  });
}

async function channelPlacement(page: Page) {
  return page.locator('[data-agenda-list]').evaluate((list) => {
    const channel = list.querySelector<HTMLElement>('[data-agenda-channel]');
    const link = list.querySelector('[data-whatsapp-channel="agenda_inline"]');
    if (!channel || !link) return null;
    const dayCounts = [...list.children]
      .filter((child) => child instanceof HTMLElement && child.dataset.agendaDay)
      .map((day) => day.querySelectorAll('[data-occurrence-id]').length);
    let before = 0;
    let after = 0;
    let seen = false;
    for (const child of list.children) {
      if (child === channel) {
        seen = true;
        continue;
      }
      const count = child.querySelectorAll('[data-occurrence-id]').length;
      if (seen) after += count;
      else before += count;
    }
    return {
      before,
      after,
      dayCounts,
      directChild: channel.parentElement === list,
      insideDay: Boolean(channel.closest('[data-agenda-day]')),
      insideDayList: Boolean(channel.closest('.agenda-day__list')),
      linkCount: list.querySelectorAll('[data-whatsapp-channel="agenda_inline"]').length,
    };
  });
}

test.describe('canal de WhatsApp en la agenda', () => {
  test('hay una sola nota entre días completos, cerca de los diez primeros conciertos', async ({ page }) => {
    await page.goto('/');
    const links = page.locator('[data-whatsapp-channel="agenda_inline"]');
    await expect(links).toHaveCount(1);
    const link = links;
    await expect(link).toHaveAttribute('href', WHATSAPP_CHANNEL_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAccessibleName(CHANNEL_NAME);
    await expect(link.locator('svg')).toHaveAttribute('aria-hidden', 'true');

    const placement = await channelPlacement(page);
    expect(placement).not.toBeNull();
    expect(placement?.directChild).toBe(true);
    expect(placement?.insideDay).toBe(false);
    expect(placement?.insideDayList).toBe(false);
    expect(placement?.linkCount).toBe(1);
    expect(placement?.after).toBeGreaterThan(0);
    const expected = expectedBreakCount(placement?.dayCounts ?? []);
    expect(expected).not.toBeNull();
    expect(placement?.before).toBe(expected);
    expect(placement?.before).toBeGreaterThanOrEqual(8);
    const boundaries = (placement?.dayCounts ?? []).reduce<number[]>((totals, count) => {
      totals.push((totals.at(-1) ?? 0) + count);
      return totals;
    }, []);
    const continuations = boundaries.slice(0, -1);
    if (continuations.some((count) => count >= 8 && count <= 12)) {
      expect(placement?.before).toBeLessThanOrEqual(12);
    }
  });

  test('el clic de la agenda y el del footer no comparten placement', async ({ page }) => {
    await installAnalytics(page);
    await page.context().route('https://whatsapp.com/**', (route) => route.fulfill({ status: 200, body: 'Canal de prueba' }));
    await page.goto('/');

    const inline = page.locator('[data-whatsapp-channel="agenda_inline"]');
    await inline.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      return (await analyticsCalls(page)).filter((call) => call.event === 'whatsapp_channel_viewed').length;
    }).toBe(1);
    expect((await analyticsCalls(page)).filter((call) => call.event === 'whatsapp_channel_viewed')).toEqual([
      { event: 'whatsapp_channel_viewed', properties: { placement: 'agenda_inline', page_type: 'agenda' } },
    ]);

    const [inlinePopup] = await Promise.all([page.waitForEvent('popup'), inline.click()]);
    await inlinePopup.close();

    const footer = page.locator('.site-footer [data-whatsapp-channel="footer"]');
    const [footerPopup] = await Promise.all([page.waitForEvent('popup'), footer.click()]);
    await footerPopup.close();

    const calls = (await analyticsCalls(page)).filter((call) => call.event === 'whatsapp_channel_clicked');
    expect(calls).toEqual([
      { event: 'whatsapp_channel_clicked', properties: { placement: 'agenda_inline', page_type: 'agenda' } },
      { event: 'whatsapp_channel_clicked', properties: { placement: 'footer', page_type: 'agenda' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain(WHATSAPP_CHANNEL_URL);
  });

  test('los filtros ocultan la nota, la agenda completa no la duplica ni repite su impresión', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/');
    const before = await channelPlacement(page);
    await page.locator('[data-whatsapp-channel="agenda_inline"]').scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      return (await analyticsCalls(page)).filter((call) => call.event === 'whatsapp_channel_viewed').length;
    }).toBe(1);
    expect(before?.before).toBeGreaterThanOrEqual(8);
    await expect(page.locator('[data-agenda-channel]')).toBeVisible();

    await page.locator('[data-agenda-shortcut="free"]').click();
    await expect(page).toHaveURL(/access=free/);
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-channel]')).toBeHidden();

    await page.locator('[data-agenda-shortcut="weekend"]').click();
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-channel]')).toBeHidden();

    await page.locator('[data-clear-filters]').click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('[data-agenda-channel]')).toBeVisible();
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    expect((await channelPlacement(page))?.before).toBe(before?.before);

    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar todos' })).toBeHidden();
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-channel]')).toBeVisible();
    expect((await channelPlacement(page))?.before).toBe(before?.before);
    expect((await channelPlacement(page))?.insideDayList).toBe(false);
    await page.locator('[data-whatsapp-channel="agenda_inline"]').scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      return (await analyticsCalls(page)).filter((call) => call.event === 'whatsapp_channel_viewed').length;
    }).toBe(1);
  });

  test('una búsqueda que descarga la agenda completa deja una sola nota oculta', async ({ page }) => {
    await page.goto('/');
    const form = page.locator('[data-agenda-filters]');
    await form.getByRole('searchbox').fill('Bach');
    await form.getByRole('button', { name: 'Buscar' }).click();
    await expect(page).toHaveURL(/\?q=/);
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-channel]')).toBeHidden();

    await page.goto('/?access=free');
    await expect(page.locator('[data-agenda-root][data-agenda-complete]')).toHaveCount(1);
    await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(1);
    await expect(page.locator('[data-agenda-channel]')).toBeHidden();
  });

  test('la nota no aparece fuera de la agenda principal', async ({ page }) => {
    await page.goto('/');
    const eventHref = await page.locator('[data-agenda-list] .agenda-item__title a').first().getAttribute('href');
    const venueHref = await page.locator('[data-agenda-list] .agenda-item__venue a').first().getAttribute('href');
    expect(eventHref).toBeTruthy();
    expect(venueHref).toBeTruthy();

    for (const path of [
      '/agenda/gratis/',
      '/agenda/fin-de-semana/',
      '/acerca-de/',
      '/lugares/',
      eventHref ?? '',
      venueHref ?? '',
    ]) {
      await page.goto(path);
      await expect(page.locator('[data-whatsapp-channel="agenda_inline"]')).toHaveCount(0);
      await expect(page.locator('.site-footer [data-whatsapp-channel="footer"]')).toHaveCount(1);
    }
  });

  test('en escritorio y móvil la nota no desborda y el enlace muestra el foco', async ({ page }) => {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.goto('/');
      const link = page.locator('[data-whatsapp-channel="agenda_inline"]');
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
      const box = await page.locator('[data-agenda-channel]').boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(-1);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  });
});
