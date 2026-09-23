import { expect, test, type Page } from '@playwright/test';

type AnalyticsCall = { event: string; properties: Record<string, unknown> };

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

function named(calls: AnalyticsCall[], event: string): AnalyticsCall[] {
  return calls.filter((call) => call.event === event);
}

test.describe('analítica de producto', () => {
  test('el footer registra el clic en el canal desde la agenda sin navegar la página', async ({ page }) => {
    await installAnalytics(page);
    await page.context().route('https://whatsapp.com/**', (route) => route.fulfill({ status: 200, body: 'Canal de prueba' }));
    await page.goto('/');
    const link = page.locator('.site-footer [data-whatsapp-channel="footer"]');
    await expect(link).toHaveAttribute('href', 'https://whatsapp.com/channel/0029VbDMlLw5Ejy6w8hyme2J');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAccessibleName(/Seguir el canal de Clásica Madrid en WhatsApp/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.close();
    expect(page.url()).toMatch(/localhost:4321\/$/);
    expect(named(await analyticsCalls(page), 'whatsapp_channel_clicked')).toEqual([
      { event: 'whatsapp_channel_clicked', properties: { placement: 'footer', page_type: 'agenda' } },
    ]);
  });

  test('Acerca de registra su ubicación y conserva el contexto de página', async ({ page }) => {
    await installAnalytics(page);
    await page.context().route('https://whatsapp.com/**', (route) => route.fulfill({ status: 200, body: 'Canal de prueba' }));
    await page.goto('/acerca-de/');
    const block = page.getByRole('region', { name: 'Clásica Madrid, también en WhatsApp' });
    await expect(block).toBeVisible();
    const link = block.getByRole('link', { name: /Seguir el canal de Clásica Madrid en WhatsApp/ });
    await expect(link).toHaveAttribute('href', 'https://whatsapp.com/channel/0029VbDMlLw5Ejy6w8hyme2J');
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.close();
    expect(named(await analyticsCalls(page), 'whatsapp_channel_clicked')).toEqual([
      { event: 'whatsapp_channel_clicked', properties: { placement: 'about', page_type: 'about' } },
    ]);
  });

  test('el canal mantiene foco visible y no provoca desbordamiento en escritorio o móvil', async ({ page }) => {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      for (const path of ['/', '/acerca-de/']) {
        await page.goto(path);
        const link = page.locator('[data-whatsapp-channel="footer"]');
        await link.focus();
        await expect(link).toBeFocused();
        expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
  });

  test('la agenda no emite filtros al cargar y la búsqueda espera al envío', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/?access=free');

    const context = JSON.parse((await page.locator('#analytics-page').textContent()) ?? '{}') as {
      page_type?: string;
    };
    expect(context.page_type).toBe('agenda');
    expect(named(await analyticsCalls(page), '$pageview')).toEqual([]);
    expect(named(await analyticsCalls(page), 'filter_changed')).toEqual([]);
    expect(named(await analyticsCalls(page), 'quick_filter_selected')).toEqual([]);
    expect(named(await analyticsCalls(page), 'search_performed')).toEqual([]);

    const search = page.locator('input[name="q"]');
    await search.fill('zzznadaqueexista123');
    await page.waitForTimeout(500);
    expect(named(await analyticsCalls(page), 'search_performed')).toEqual([]);

    await page.locator('.search-submit').click();
    await expect.poll(async () => named(await analyticsCalls(page), 'search_performed').length, { timeout: 15_000 }).toBe(1);
    const searchCall = named(await analyticsCalls(page), 'search_performed')[0];
    expect(searchCall?.properties).toMatchObject({
      surface: 'agenda',
      query: 'zzznadaqueexista123',
      results_count: 0,
    });
    expect(named(await analyticsCalls(page), 'result_list_exhausted')).toEqual([]);
  });

  test('el atajo y limpiar filtros son acciones distintas', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/');
    await page.locator('[data-agenda-shortcut="weekend"]').click();
    await expect
      .poll(async () => named(await analyticsCalls(page), 'quick_filter_selected').length, { timeout: 15_000 })
      .toBe(1);
    expect(named(await analyticsCalls(page), 'quick_filter_selected')[0]?.properties.quick_filter).toBe('weekend');
    expect(named(await analyticsCalls(page), 'filter_changed')).toEqual([]);

    await page.locator('[data-clear-filters]').click();
    await expect.poll(async () => named(await analyticsCalls(page), 'filter_cleared').length).toBe(1);
    expect(named(await analyticsCalls(page), 'filter_cleared')[0]?.properties.filter_key).toBe('all');
  });

  test('una ficha de evento se abre una vez y el enlace externo no sustituye la página', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/eventos/cuarteto-cosmos/');
    await expect.poll(async () => named(await analyticsCalls(page), 'event_opened').length).toBe(1);
    await page.waitForTimeout(300);
    expect(named(await analyticsCalls(page), 'event_opened')).toHaveLength(1);
    expect(named(await analyticsCalls(page), '$pageview')).toEqual([]);

    const opened = named(await analyticsCalls(page), 'event_opened')[0];
    expect(opened?.properties.event_id).toEqual(expect.any(String));
    expect(String(opened?.properties.event_id)).toMatch(/^evt_/);
    expect(opened?.properties.event_title).toBeTruthy();
    expect(opened?.properties).not.toHaveProperty('email');

    const action = page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ });
    await expect(action).toHaveAttribute('target', '_blank');
    const href = await action.getAttribute('href');
    const [popup] = await Promise.all([page.waitForEvent('popup'), action.click()]);
    expect(page.url()).toContain('/eventos/cuarteto-cosmos/');
    expect(popup.url() === 'about:blank' || popup.url().startsWith('http')).toBe(true);
    await popup.close();

    const outbound = named(await analyticsCalls(page), 'outbound_event_click');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.properties.event_id).toBe(opened?.properties.event_id);
    expect(outbound[0]?.properties.destination_domain).toEqual(expect.any(String));
    expect(JSON.stringify(outbound[0]?.properties)).not.toContain(href ?? 'https://unused');
    expect(['tickets', 'source']).toContain(outbound[0]?.properties.destination_type);

    const maps = page.getByRole('link', { name: /Ver .* en Google Maps/ });
    const [mapsPopup] = await Promise.all([page.waitForEvent('popup'), maps.click()]);
    expect(page.url()).toContain('/eventos/cuarteto-cosmos/');
    await mapsPopup.close();
    expect(named(await analyticsCalls(page), 'directions_clicked')).toEqual([
      expect.objectContaining({
        event: 'directions_clicked',
        properties: expect.objectContaining({ provider: 'google_maps', venue_id: opened?.properties.venue_id }),
      }),
    ]);
  });

  test('lugares registra la ficha, la búsqueda debounced y el final de lista una vez', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/lugares/');
    const indexContext = JSON.parse((await page.locator('#analytics-page').textContent()) ?? '{}') as {
      page_type?: string;
    };
    expect(indexContext.page_type).toBe('venues');
    const listTag = await page.locator('[data-venue-list]').evaluate((list) => {
      const sentinel = list.querySelector(':scope > [data-results-end]');
      return {
        list: list.tagName,
        sentinel: sentinel?.tagName ?? null,
        hidden: sentinel?.getAttribute('aria-hidden') ?? null,
        directDivs: [...list.children].filter((child) => child.tagName === 'DIV').length,
        borderBottom: sentinel ? getComputedStyle(sentinel).borderBottomWidth : null,
        height: sentinel ? getComputedStyle(sentinel).height : null,
      };
    });
    expect(listTag).toEqual({
      list: 'UL',
      sentinel: 'LI',
      hidden: 'true',
      directDivs: 0,
      borderBottom: '0px',
      height: '1px',
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(async () => named(await analyticsCalls(page), 'result_list_exhausted').length).toBe(1);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(200);
    expect(named(await analyticsCalls(page), 'result_list_exhausted')).toHaveLength(1);

    const input = page.locator('[data-venue-search]');
    await input.pressSequentially('zzz', { delay: 30 });
    await page.waitForTimeout(120);
    expect(named(await analyticsCalls(page), 'search_performed')).toEqual([]);
    await expect.poll(async () => named(await analyticsCalls(page), 'search_performed').length).toBe(1);
    expect(named(await analyticsCalls(page), 'search_performed')[0]?.properties).toMatchObject({
      surface: 'venues',
      query: 'zzz',
      results_count: 0,
    });

    await page.goto('/lugares/teatro-real/');
    await expect.poll(async () => named(await analyticsCalls(page), 'venue_opened').length).toBe(1);
    await page.waitForTimeout(200);
    expect(named(await analyticsCalls(page), 'venue_opened')).toHaveLength(1);
    const venue = named(await analyticsCalls(page), 'venue_opened')[0];
    expect(String(venue?.properties.venue_id)).toMatch(/^ven_/);
    expect(venue?.properties.venue_name).toBeTruthy();
  });

  test('escribir en lugares filtra al momento y solo agota la búsqueda estabilizada', async ({ page }) => {
    await installAnalytics(page);
    await page.goto('/lugares/');
    const search = page.locator('[data-venue-search]');
    const totalVenues = await page.locator('[data-venue-entry]').count();
    expect(totalVenues).toBeGreaterThan(1);
    expect(named(await analyticsCalls(page), 'result_list_exhausted')).toEqual([]);

    await search.pressSequentially('hinves', { delay: 20 });
    expect(named(await analyticsCalls(page), 'search_performed')).toEqual([]);
    expect(named(await analyticsCalls(page), 'result_list_exhausted')).toEqual([]);
    const visibleWhileTyping = await page.locator('[data-venue-entry]:not([hidden])').count();
    expect(visibleWhileTyping).toBeGreaterThan(0);
    expect(visibleWhileTyping).toBeLessThan(totalVenues);

    await expect.poll(async () => named(await analyticsCalls(page), 'search_performed').length).toBe(1);
    expect(named(await analyticsCalls(page), 'search_performed')[0]?.properties).toMatchObject({
      surface: 'venues',
      query: 'hinves',
      results_count: visibleWhileTyping,
    });
    await page.locator('[data-venue-list] [data-results-end]').scrollIntoViewIfNeeded();
    await expect.poll(async () => named(await analyticsCalls(page), 'result_list_exhausted').length).toBe(1);
    const exhausted = named(await analyticsCalls(page), 'result_list_exhausted');
    expect(exhausted[0]?.properties).toMatchObject({
      surface: 'venues',
      has_search_query: true,
      results_count: visibleWhileTyping,
      active_filter_count: 0,
    });

    await page.locator('[data-venue-search-clear]').click();
    await expect.poll(async () => page.locator('[data-venue-entry]:not([hidden])').count()).toBe(totalVenues);
    await page.waitForTimeout(450);
    expect(named(await analyticsCalls(page), 'search_performed')).toHaveLength(1);
    expect(named(await analyticsCalls(page), 'result_list_exhausted')).toHaveLength(1);
  });

  test('las landings de atajo abren el concierto como quick_filter', async ({ page, baseURL }) => {
    test.skip(!baseURL, 'falta baseURL');
    const originFor = async (refererPath: string) => {
      await page.goto('/eventos/cuarteto-cosmos/', { referer: new URL(refererPath, baseURL).href });
      await expect.poll(async () => named(await analyticsCalls(page), 'event_opened').length).toBe(1);
      return named(await analyticsCalls(page), 'event_opened')[0]?.properties.origin;
    };

    await installAnalytics(page);
    expect(await originFor('/agenda/gratis/')).toBe('quick_filter');
    expect(await originFor('/agenda/fin-de-semana/')).toBe('quick_filter');
    expect(await originFor('/agenda/opera/')).toBe('agenda');

    for (const landing of [
      { path: '/agenda/gratis/', quickFilter: 'free' },
      { path: '/agenda/fin-de-semana/', quickFilter: 'weekend' },
    ] as const) {
      await page.goto(landing.path);
      const list = page.locator('[data-results-surface="agenda"]');
      if ((await list.count()) === 0) continue;
      await expect(list).toHaveAttribute('data-quick-filter', landing.quickFilter);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect.poll(async () => named(await analyticsCalls(page), 'result_list_exhausted').length).toBe(1);
      expect(named(await analyticsCalls(page), 'result_list_exhausted')[0]?.properties).toMatchObject({
        surface: 'agenda',
        quick_filter: landing.quickFilter,
        active_filter_count: 1,
        has_search_query: false,
      });
    }
  });

  test('el contacto solo se registra después de un envío correcto y sin datos del mensaje', async ({ page }) => {
    await installAnalytics(page);
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `(() => { let callback; window.turnstile = { render(_el, options) { callback = options.callback; setTimeout(() => callback('e2e-token'), 0); return 'w'; }, reset() { setTimeout(() => callback && callback('e2e-token-2'), 0); } }; })();`,
      });
    });
    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    await page.goto('/contacto/');
    const context = JSON.parse((await page.locator('#analytics-page').textContent()) ?? '{}') as {
      page_type?: string;
    };
    expect(context.page_type).toBe('contact');

    await page.getByLabel('Nombre (opcional)').fill('Ana');
    await page.getByLabel('Email (opcional)').fill('ana@example.com');
    await page.getByLabel('Motivo').selectOption('Corrección');
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Hay una hora incorrecta.');
    await page.getByRole('button', { name: 'Enviar mensaje' }).click();
    await expect(page.getByRole('status')).toContainText('No hemos podido enviar');
    expect(named(await analyticsCalls(page), 'contact_submitted')).toEqual([]);

    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('status')).toHaveText('Gracias. Tu mensaje se ha enviado.');
    const submitted = named(await analyticsCalls(page), 'contact_submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.properties).toEqual({ surface: 'contact', topic: 'Corrección' });
    expect(JSON.stringify(submitted)).not.toContain('ana@');
    expect(JSON.stringify(submitted)).not.toContain('hora incorrecta');
    expect(JSON.stringify(submitted)).not.toContain('Ana');
  });

  test('Avisarnos emite un único event_feedback_clicked', async ({ page }) => {
    await page.addInitScript(() => {
      const key = '__cm_analytics_test';
      Object.defineProperty(window, 'posthog', {
        configurable: true,
        value: {
          capture(event, properties) {
            const calls = JSON.parse(sessionStorage.getItem(key) || '[]');
            calls.push({ event, properties: { ...properties } });
            sessionStorage.setItem(key, JSON.stringify(calls));
          },
        },
      });
    });

    await page.goto('/eventos/andromeda-y-perseo-publico-general/');
    await page.getByRole('link', { name: 'Avísanos', exact: true }).click();
    await expect(page).toHaveURL(/\/contacto\/\?motivo=correccion&event_id=evt_andromeda_perseo_publico_2026/);
    await expect(page.getByLabel('Motivo')).toHaveValue('Corrección');
    await expect(page.getByRole('textbox', { name: 'Mensaje', exact: true })).toHaveValue('');

    const calls = (await page.evaluate(() => {
      return JSON.parse(sessionStorage.getItem('__cm_analytics_test') || '[]');
    })) as AnalyticsCall[];
    const clicked = calls.filter((call) => call.event === 'event_feedback_clicked');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.properties).toEqual({
      event_id: 'evt_andromeda_perseo_publico_2026',
      event_title: 'Andrómeda y Perseo',
      placement: 'after_sources',
    });
    const serialized = JSON.stringify(clicked);
    expect(serialized).not.toContain('motivo=');
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('@');
  });

  test('el aviso navega a contacto aunque PostHog falle', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'posthog', {
        configurable: true,
        value: {
          capture() {
            throw new Error('analytics down');
          },
        },
      });
    });
    await page.goto('/eventos/andromeda-y-perseo-publico-general/');
    await page.getByRole('link', { name: 'Avísanos', exact: true }).click();
    await expect(page).toHaveURL(/\/contacto\/\?motivo=correccion/);
    await expect(page.getByLabel('Motivo')).toHaveValue('Corrección');
    expect(errors).toEqual([]);
  });

  test('un envío desde una ficha añade origin y event_id solo si el POST tiene éxito', async ({ page }) => {
    await installAnalytics(page);
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `(() => { let callback; window.turnstile = { render(_el, options) { callback = options.callback; setTimeout(() => callback('e2e-token'), 0); return 'w'; }, reset() { setTimeout(() => callback && callback('e2e-token-2'), 0); } }; })();`,
      });
    });
    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    await page.goto(
      '/contacto/?motivo=correccion&event_id=evt_andromeda_perseo_publico_2026&event_slug=andromeda-y-perseo-publico-general&origin=event_feedback',
    );
    await expect(page.getByLabel('Motivo')).toHaveValue('Corrección');
    await page.getByLabel('Nombre (opcional)').fill('Ana');
    await page.getByLabel('Email (opcional)').fill('ana@example.com');
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Hay una hora incorrecta.');
    await page.getByRole('button', { name: 'Enviar mensaje' }).click();
    await expect(page.getByRole('status')).toContainText('No hemos podido enviar');
    expect(named(await analyticsCalls(page), 'contact_submitted')).toEqual([]);

    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('status')).toHaveText('Gracias. Tu mensaje se ha enviado.');
    const submitted = named(await analyticsCalls(page), 'contact_submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.properties).toEqual({
      surface: 'contact',
      topic: 'Corrección',
      origin: 'event_feedback',
      event_id: 'evt_andromeda_perseo_publico_2026',
    });
    const serialized = JSON.stringify(submitted);
    expect(serialized).not.toContain('ana@');
    expect(serialized).not.toContain('hora incorrecta');
    expect(serialized).not.toContain('Ana');
    expect(serialized).not.toContain('andromeda-y-perseo');
  });
});
