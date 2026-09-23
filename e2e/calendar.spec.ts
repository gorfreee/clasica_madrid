import { expect, test, type Page } from '@playwright/test';

const SINGLE = '/eventos/excelentia-vivaldi-paganini/';
const SINGLE_OCCURRENCE = 'occ_auditorio_nacional_excelentia_vivaldi_paganini_1_01';
const MULTI = '/eventos/ocne-sinfonico-14/';
const UNCONFIRMED = '/eventos/joven-camerata-de-la-orcam/';
const UNCONFIRMED_OCCURRENCE = 'occ_teatros_canal_99906_01';
const FREE = '/eventos/belen-vaquero/';
const PAST = '/eventos/recital-de-piano/';
const LONG_TITLE =
  '/eventos/la-emancipacion-de-las-virtuosas-ii-adelina-patti-a-traves-de-galdos-el-precio-de-la-diva/';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 820, height: 900 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function openCalendar(page: Page) {
  const trigger = page.getByRole('button', { name: 'Añadir al calendario', exact: true });
  await trigger.click();
  return trigger;
}

function googleLinks(page: Page) {
  return page.locator('[data-calendar-method="google_calendar"]');
}

test.describe('añadir al calendario', () => {
  test('una función enlaza Google y el .ics sin competir con las entradas', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(SINGLE);

    const actions = page.locator('.event-actions');
    const cta = actions.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ });
    const calendar = actions.getByRole('button', { name: 'Añadir al calendario', exact: true });
    const share = actions.getByRole('button', { name: 'Compartir', exact: true });
    await expect(calendar).toBeVisible();
    await expect(page.getByRole('link', { name: /Outlook/ })).toHaveCount(0);

    const [ctaBox, calendarBox, shareBox] = await Promise.all([
      cta.boundingBox(),
      calendar.boundingBox(),
      share.boundingBox(),
    ]);
    expect(ctaBox && calendarBox && shareBox).toBeTruthy();
    expect(calendarBox!.x).toBeGreaterThan(ctaBox!.x + ctaBox!.width - 1);
    expect(shareBox!.x).toBeGreaterThan(calendarBox!.x + calendarBox!.width - 1);
    expect(calendarBox!.height).toBeGreaterThanOrEqual(44);

    const triggerStyle = await calendar.evaluate((element) => {
      const style = getComputedStyle(element);
      return { weight: style.fontWeight, border: style.borderTopWidth, background: style.backgroundColor };
    });
    expect(Number(triggerStyle.weight)).toBeLessThan(800);
    expect(triggerStyle.border).toBe('0px');

    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toBe('https://clasicamadrid.com/eventos/excelentia-vivaldi-paganini/');
    expect(canonical).not.toContain('utm_');

    await openCalendar(page);
    await expect(page.locator('.calendar-action__when')).toContainText('19:30');
    await expect(page.getByText('Elige una función')).toHaveCount(0);

    const google = page.getByRole('link', { name: /Google Calendar/ });
    const ics = page.getByRole('link', { name: /Apple, Outlook y otras apps/ });
    await expect(google).toBeVisible();
    await expect(ics).toBeVisible();
    expect((await google.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    const googleUrl = new URL((await google.getAttribute('href')) ?? '');
    expect(googleUrl.searchParams.get('action')).toBe('TEMPLATE');
    expect(googleUrl.searchParams.get('ctz')).toBe('Europe/Madrid');
    expect(googleUrl.searchParams.get('text')).toBe('Excelentia. Vivaldi & Paganini');
    expect(googleUrl.searchParams.get('dates')).toBe('20270306T193000/20270306T193000');
    expect(googleUrl.searchParams.get('location')).toBe(
      'Sala de Cámara · Auditorio Nacional de Música, Calle del Príncipe de Vergara, 146, 28002 Madrid',
    );
    expect(googleUrl.searchParams.get('location')).not.toContain('Madrid, Madrid');
    const details = googleUrl.searchParams.get('details') ?? '';
    expect(details).toContain('https://clasicamadrid.com/eventos/excelentia-vivaldi-paganini/?utm_source=google_calendar&utm_medium=calendar');
    expect(details).not.toContain('utm_source=ics');
    expect(googleUrl.searchParams.get('utm_source')).toBeNull();

    const icsHref = (await ics.getAttribute('href')) ?? '';
    expect(icsHref).toBe(`/eventos/excelentia-vivaldi-paganini/${SINGLE_OCCURRENCE}.ics`);
    const response = await page.request.get(icsHref);
    expect(response.ok()).toBe(true);
    const body = (await response.body()).toString('utf8');
    expect(body.replaceAll('\r\n', '')).not.toContain('\n');
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain(`UID:${SINGLE_OCCURRENCE}@clasicamadrid.com`);
    expect(body).toContain('DTSTART:20270306T183000Z');
    expect(body).not.toContain('DTEND');
    expect(body).not.toContain('<');
    expect(body).not.toContain('&amp;');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
    expect(body).toContain('utm_source=ics');
    expect(body).toContain('utm_medium=calendar');
    expect(body).toContain('Príncipe de Vergara');
    expect(body).not.toContain('Clásica Madrid\r\n');
    expect(body).toContain('SUMMARY:Excelentia. Vivaldi & Paganini');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(SINGLE);
    const [mobileCta, mobileCalendar, mobileShare] = await Promise.all([
      page.locator('.event-actions').getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ }).boundingBox(),
      page.getByRole('button', { name: 'Añadir al calendario', exact: true }).boundingBox(),
      page.getByRole('button', { name: 'Compartir', exact: true }).boundingBox(),
    ]);
    expect(mobileCta && mobileCalendar && mobileShare).toBeTruthy();
    expect(mobileCalendar!.y).toBeGreaterThan(mobileCta!.y + mobileCta!.height - 1);
    expect(mobileShare!.y).toBeGreaterThan(mobileCalendar!.y + mobileCalendar!.height - 1);
  });

  test('varias funciones obligan a elegir una fecha y dejan fuera las canceladas', async ({ page }) => {
    await page.goto(MULTI);
    await openCalendar(page);
    await expect(page.getByText('Elige una función')).toBeVisible();
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toHaveCount(0);

    const hrefs = await googleLinks(page).evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    expect(hrefs).toHaveLength(3);
    const dates = hrefs.map((href) => new URL(href).searchParams.get('dates'));
    expect(new Set(dates).size).toBe(3);
    for (const value of dates) {
      const [start, end] = (value ?? '').split('/');
      expect(end).toBe(start);
      expect(start).toMatch(/^\d{8}T\d{6}$/);
    }
    expect(hrefs.join(' ')).not.toContain('cancelled');

    const second = page.locator('[data-calendar-date] summary').nth(1);
    await second.click();
    const visible = new URL((await page.getByRole('link', { name: /Google Calendar/ }).getAttribute('href')) ?? '');
    expect(visible.searchParams.get('dates')).toBe(dates[1]);
    await expect(page.locator('[data-calendar-method="ics"]')).toHaveCount(3);
    await expect(page.getByRole('link', { name: /Apple, Outlook y otras apps/ })).toHaveCount(1);
    expect((await page.getByRole('link', { name: /Apple, Outlook y otras apps/ }).getAttribute('href')) ?? '').toMatch(
      /^\/eventos\/ocne-sinfonico-14\/occ_.*\.ics$/,
    );
  });

  test('una hora por confirmar se guarda como día completo', async ({ page }) => {
    await page.goto(UNCONFIRMED);
    await openCalendar(page);
    await expect(page.locator('.calendar-action__when')).toContainText('Hora por confirmar');

    const googleUrl = new URL((await page.getByRole('link', { name: /Google Calendar/ }).getAttribute('href')) ?? '');
    expect(googleUrl.searchParams.get('text')).toBe('Joven Camerata de la ORCAM — hora por confirmar');
    expect(googleUrl.searchParams.get('dates')).toBe('20270622/20270623');
    expect(googleUrl.searchParams.get('dates')).not.toContain('T');
    expect(googleUrl.searchParams.get('details') ?? '').toMatch(/^Hora por confirmar/);
    expect(googleUrl.searchParams.get('location')).toContain('Sala Verde');
    expect(googleUrl.searchParams.get('location')).toContain('Cea Bermúdez');
    expect(googleUrl.searchParams.get('location')).not.toContain('Madrid, Madrid');

    const icsHref = `/eventos/joven-camerata-de-la-orcam/${UNCONFIRMED_OCCURRENCE}.ics`;
    expect(await page.getByRole('link', { name: /Apple, Outlook y otras apps/ }).getAttribute('href')).toBe(icsHref);
    const body = (await (await page.request.get(icsHref)).body()).toString('utf8');
    expect(body).toContain('DTSTART;VALUE=DATE:20270622');
    expect(body).not.toContain('DTEND');
    expect(body).not.toMatch(/DTSTART:/);
    expect(body).toContain('hora por confirmar');
    expect(body).toContain('Hora por confirmar en el momento de guardar este evento');
    expect(body.replaceAll('\r\n', '')).not.toContain('\n');
    expect(body).not.toContain('<');
    expect(body).not.toContain('undefined');
  });

  test('no aparece en un evento pasado y sí en uno gratuito', async ({ page }) => {
    await page.goto(PAST);
    await expect(page.locator('.past-notice')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Añadir al calendario', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Compartir', exact: true })).toBeVisible();

    await page.goto(FREE);
    await expect(page.getByRole('button', { name: 'Añadir al calendario', exact: true })).toBeVisible();
    await openCalendar(page);
    await expect(page.getByText('Elige una función')).toBeVisible();
  });

  test('se recorre con teclado y Escape devuelve el foco', async ({ page }) => {
    await page.goto(SINGLE);
    const trigger = page.getByRole('button', { name: 'Añadir al calendario', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Apple, Outlook y otras apps/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    await page.goto(MULTI);
    const multi = page.getByRole('button', { name: 'Añadir al calendario', exact: true });
    await multi.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const firstDate = page.locator('[data-calendar-date] summary').first();
    await expect(firstDate).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(multi).toBeFocused();
    await expect(page.getByRole('link', { name: /Google Calendar/ })).toBeHidden();
  });

  test('el menú no se sale del viewport', async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(MULTI);
      await openCalendar(page);
      await page.locator('[data-calendar-date] summary').first().click();
      await expectMenuInside(page, viewport);
      await expectNoHorizontalOverflow(page);

      await page.goto(LONG_TITLE);
      await openCalendar(page);
      await expectMenuInside(page, viewport);
      await expectNoHorizontalOverflow(page);
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(SINGLE);
    await openCalendar(page);
    await expectMenuInside(page, { width: 375, height: 812 });
    await expectNoHorizontalOverflow(page);
  });

  test('el analytics sale al elegir el método y no al abrir el menú', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: { event: string; properties: Record<string, unknown> }[] = [];
      (window as unknown as { __analytics: typeof calls }).__analytics = calls;
      Object.defineProperty(window, 'posthog', {
        configurable: true,
        value: {
          capture(event: string, properties: Record<string, unknown>) {
            calls.push({ event, properties });
          },
        },
      });
    });
    await page.route('https://calendar.google.com/**', (route) => route.fulfill({ status: 204, body: '' }));
    await page.route('**/*.ics', async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({
          status: 200,
          contentType: 'text/calendar; charset=utf-8',
          body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        });
        return;
      }
      await route.continue();
    });

    await page.goto(SINGLE);
    await openCalendar(page);
    await page.locator('[data-calendar-date] summary').count();
    expect(await calendarCalls(page)).toEqual([]);

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: /Google Calendar/ }).click();
    await (await popupPromise).close();
    expect(await calendarCalls(page)).toEqual([
      {
        event: 'calendar_add_clicked',
        properties: {
          event_id: 'evt_auditorio_nacional_excelentia_vivaldi_paganini_1',
          event_title: 'Excelentia. Vivaldi & Paganini',
          occurrence_id: SINGLE_OCCURRENCE,
          method: 'google_calendar',
          has_confirmed_time: true,
        },
      },
    ]);
    const payload = JSON.stringify(await calendarCalls(page));
    expect(payload).not.toContain('Príncipe');
    expect(payload).not.toContain('utm_');
    expect(payload).not.toContain('BEGIN:VCALENDAR');

    await page.getByRole('link', { name: /Apple, Outlook y otras apps/ }).click();
    const calls = await calendarCalls(page);
    expect(calls[1]?.properties).toMatchObject({
      method: 'ics',
      occurrence_id: SINGLE_OCCURRENCE,
      has_confirmed_time: true,
    });
  });

  test('elegir un método no falla si PostHog no está', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://calendar.google.com/**', (route) => route.fulfill({ status: 204, body: '' }));
    await page.goto(UNCONFIRMED);
    await openCalendar(page);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: /Google Calendar/ }).click();
    await (await popupPromise).close();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => 'posthog' in window)).toBe(false);
  });

  test('sin JavaScript los enlaces ya están en el HTML', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      const page = await context.newPage();
      await page.goto(SINGLE);
      const google = page.locator('[data-calendar-method="google_calendar"]');
      const ics = page.locator('[data-calendar-method="ics"]');
      expect(await google.getAttribute('href')).toContain('calendar.google.com/calendar/render');
      expect(await google.getAttribute('href')).toContain('dates=20270306T193000%2F20270306T193000');
      expect(await ics.getAttribute('href')).toBe(`/eventos/excelentia-vivaldi-paganini/${SINGLE_OCCURRENCE}.ics`);

      await page.goto(MULTI);
      expect(await page.locator('[data-calendar-method="google_calendar"]').count()).toBe(3);
      expect(await page.locator('[data-calendar-date]').count()).toBe(3);
    } finally {
      await context.close();
    }
  });
});

async function expectMenuInside(page: Page, viewport: { width: number; height: number }) {
  const box = await page.locator('[data-calendar-menu]').boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function calendarCalls(page: Page) {
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __analytics: { event: string; properties: Record<string, unknown> }[] }).__analytics,
  );
  return calls.filter((call) => call.event === 'calendar_add_clicked');
}
