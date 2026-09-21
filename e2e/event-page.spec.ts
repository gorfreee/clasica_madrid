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
    await expect(about.locator('.concert-profile__row--quiet dt')).toHaveText('Programación');

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
    await expect(page.locator('.page-hero__artwork')).toBeHidden();
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
