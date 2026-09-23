import { expect, test, type Page } from '@playwright/test';

const FULL_EVENT = '/eventos/andromeda-y-perseo-publico-general/';
const COMPOSERS_ONLY = '/eventos/laura-sierra-piano/';
const UNKNOWN_ACCESS = '/eventos/orquesta-camerata-musicalis-mucho-mas-que-un-concierto-schubert/';
const WITH_SPACE = '/eventos/cuarteto-cosmos-y-vicent-alberola-clarinete/';
const LONG_VENUE = '/eventos/coma-26-trio-fernandez-apellaniz/';
const LONG_TITLE =
  '/eventos/xxviii-festival-internacional-de-musica-contemporanea-de-madrid-coma-26-orquesta-sinfonica-de-la-universidad-complutense/';
const PAST_EVENT = '/eventos/recital-de-piano/';

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
}

async function headingNames(page: Page) {
  const names = await page.getByRole('heading', { level: 2 }).allInnerTexts();
  return names.map((name) => name.replace(/\s+/g, ' ').trim());
}

const FEEDBACK_EVENT = '/eventos/andromeda-y-perseo-publico-general/';
const FEEDBACK_EVENT_ID = 'evt_andromeda_perseo_publico_2026';

test.describe('aviso de corrección en la ficha', () => {
  test('coloca un único enlace después de la última verificación', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(FEEDBACK_EVENT);

    const fuentes = page.locator('section.sources');
    const link = fuentes.getByRole('link', { name: 'Avísanos', exact: true });
    await expect(page.getByRole('link', { name: 'Avísanos', exact: true })).toHaveCount(1);
    await expect(fuentes.locator('.source-feedback')).toHaveText('¿Ves algún error o cambio? Avísanos.');
    await expect(link).toHaveAttribute('data-event-feedback', 'after_sources');

    const href = await link.getAttribute('href');
    const url = new URL(href ?? '', 'http://localhost');
    expect(url.pathname).toBe('/contacto/');
    expect(url.searchParams.get('motivo')).toBe('correccion');
    expect(url.searchParams.get('event_id')).toBe(FEEDBACK_EVENT_ID);
    expect(url.searchParams.get('event_slug')).toBe('andromeda-y-perseo-publico-general');
    expect(url.searchParams.get('origin')).toBe('event_feedback');
    expect([...url.searchParams.keys()]).toEqual(['motivo', 'event_id', 'event_slug', 'origin']);
    expect(href).not.toMatch(/email|nombre|mensaje|compositor|interprete|programa/i);

    const followsVerification = await fuentes.locator('.source-feedback').evaluate((node) => {
      const previous = node.previousElementSibling;
      return (
        previous?.classList.contains('verified') === true &&
        previous.classList.contains('source-feedback') === false &&
        previous.textContent?.includes('Última verificación') === true &&
        node.parentElement?.lastElementChild === node
      );
    });
    expect(followsVerification).toBe(true);

    const [verifiedBox, feedbackBox, shareBox, ctaBox] = await Promise.all([
      fuentes.locator('.verified').first().boundingBox(),
      fuentes.locator('.source-feedback').boundingBox(),
      page.getByRole('button', { name: 'Compartir', exact: true }).boundingBox(),
      page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ }).boundingBox(),
    ]);
    expect(verifiedBox && feedbackBox && shareBox && ctaBox).toBeTruthy();
    expect(feedbackBox!.y).toBeGreaterThan(verifiedBox!.y + verifiedBox!.height - 1);
    expect(feedbackBox!.y).toBeGreaterThan(shareBox!.y);
    expect(feedbackBox!.y).toBeGreaterThan(ctaBox!.y);
    await expect(page.locator('.event-actions').getByRole('link', { name: 'Avísanos' })).toHaveCount(0);
  });

  test('se lee en escritorio y móvil, con foco visible y sin desbordar', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(FEEDBACK_EVENT);
      const link = page.getByRole('link', { name: 'Avísanos', exact: true });
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
      await expectNoHorizontalOverflow(page);
    }
  });
});

test.describe('jerarquía de la ficha de evento', () => {
  test('ordena las secciones y deja el acceso fuera del bloque práctico', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(FULL_EVENT);

    expect(await headingNames(page)).toEqual([
      'Fechas',
      'Sobre el concierto',
      'Compositores',
      'Intérpretes',
      'Programa',
      'Fuentes',
    ]);

    const facts = page.locator('.event-facts');
    await expect(facts.locator('dt').first()).toHaveText(/^(Próxima función|Tuvo lugar)$/);
    await expect(facts.locator('dt', { hasText: 'Lugar' })).toBeVisible();
    await expect(facts.locator('dt', { hasText: 'Acceso' })).toHaveCount(0);

    const about = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Sobre el concierto', level: 2 }),
    });
    await expect(about.locator('dt')).toHaveText(['Acceso', 'Formato', 'Época', 'Organiza', 'Programación']);
    await expect(about.locator('dd').first()).toHaveText('Gratuito');
    const type = await page.evaluate(() => {
      const signature = (element: Element) => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing, style.color].join('|');
      };
      const values = [...document.querySelectorAll('.concert-profile dd')];
      return {
        fechas: signature(document.querySelector('#fechas-titulo')!),
        interpretes: signature(document.querySelector('#interpretes-titulo')!),
        programa: signature(document.querySelector('#obras-titulo')!),
        acceso: signature(values[0]!),
        programacion: signature(values.at(-1)!),
      };
    });
    expect(type.interpretes).toBe(type.fechas);
    expect(type.programa).toBe(type.fechas);
    expect(type.programacion).toBe(type.acceso);

    const fechas = page.getByRole('heading', { name: 'Fechas', level: 2 });
    const actions = page.locator('.event-actions');
    const [factsBox, actionsBox, fechasBox] = await Promise.all([
      facts.boundingBox(),
      actions.boundingBox(),
      fechas.boundingBox(),
    ]);
    expect(factsBox && actionsBox && fechasBox).toBeTruthy();
    expect(actionsBox!.y).toBeGreaterThan(factsBox!.y + factsBox!.height - 1);
    expect(fechasBox!.y).toBeGreaterThan(actionsBox!.y);

    const [whenBox, venueBox] = await Promise.all([
      page.locator('.event-facts__when').boundingBox(),
      page.locator('.event-facts__venue').boundingBox(),
    ]);
    expect(whenBox && venueBox).toBeTruthy();
    expect(venueBox!.x).toBeGreaterThan(whenBox!.x + whenBox!.width - 2);
    expect(venueBox!.width).toBeGreaterThan(whenBox!.width);
  });

  test('oculta las secciones musicales vacías y el acceso desconocido', async ({ page }) => {
    await page.goto(COMPOSERS_ONLY);
    expect(await headingNames(page)).toEqual([
      'Fechas',
      'Sobre el concierto',
      'Compositores',
      'Fuentes',
    ]);
    await expect(page.getByRole('heading', { name: 'Intérpretes', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Programa', level: 2 })).toHaveCount(0);

    await page.goto(UNKNOWN_ACCESS);
    await expect(page.locator('dt', { hasText: 'Acceso' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sobre el concierto', level: 2 })).toBeVisible();

    await page.goto(WITH_SPACE);
    await expect(page.locator('.event-facts').locator('dt', { hasText: 'Sala' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compositores', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Intérpretes', level: 2 })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Programa', level: 2 })).toHaveCount(0);
  });

  test('coloca el aviso de archivo después de las fuentes', async ({ page }) => {
    await page.goto(PAST_EVENT);
    await expect(page.locator('.page-hero .status-alert')).toHaveCount(0);
    const notice = page.locator('.past-notice');
    await expect(notice).toHaveText(
      'Este evento ya ha tenido lugar. Conservamos la ficha como parte del archivo',
    );
    const [noticeBox, fuentesBox, shareBox] = await Promise.all([
      notice.boundingBox(),
      page.getByRole('heading', { name: 'Fuentes', level: 2 }).boundingBox(),
      page.getByRole('button', { name: 'Compartir', exact: true }).boundingBox(),
    ]);
    expect(noticeBox && fuentesBox && shareBox).toBeTruthy();
    expect(noticeBox!.y).toBeGreaterThan(fuentesBox!.y);
    expect(noticeBox!.y).toBeGreaterThan(shareBox!.y);
  });

  test('se lee en escritorio, tablet y móvil sin desbordar', async ({ page }) => {
    const routes = [FULL_EVENT, LONG_VENUE, LONG_TITLE, WITH_SPACE, PAST_EVENT];

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 820, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await page.goto(route);
        await expect(page.locator('.event-facts__when')).toBeVisible();
        await expect(page.locator('.event-facts__venue')).toBeVisible();
        await expect(page.locator('[data-hero-motif], .page-hero__artwork')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
      }
    }

    await page.setViewportSize({ width: 820, height: 900 });
    await page.goto(LONG_VENUE);
    const [tabletWhen, tabletVenue] = await Promise.all([
      page.locator('.event-facts__when').boundingBox(),
      page.locator('.event-facts__venue').boundingBox(),
    ]);
    expect(tabletWhen && tabletVenue).toBeTruthy();
    expect(tabletVenue!.x).toBeGreaterThan(tabletWhen!.x + tabletWhen!.width - 2);
    expect(tabletVenue!.width).toBeGreaterThan(tabletWhen!.width);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(LONG_TITLE);
    const [mobileWhen, mobileVenue, mobileCta] = await Promise.all([
      page.locator('.event-facts__when').boundingBox(),
      page.locator('.event-facts__venue').boundingBox(),
      page.getByRole('link', { name: /Entradas e información oficial|Ver fuente original/ }).boundingBox(),
    ]);
    expect(mobileWhen && mobileVenue && mobileCta).toBeTruthy();
    expect(mobileVenue!.y).toBeGreaterThan(mobileWhen!.y + mobileWhen!.height - 2);
    expect(mobileVenue!.x).toBeLessThan(mobileWhen!.x + 8);
    expect(mobileCta!.height).toBeGreaterThanOrEqual(44);
    expect(mobileCta!.width).toBeGreaterThan(160);
  });
});
