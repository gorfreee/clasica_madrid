import { expect, test } from '@playwright/test';

const LEGACY_EYEBROWS = [
  'Agenda / Madrid',
  'Lugares / Madrid',
  'Acerca de / Clásica Madrid',
  'Agenda / Evento',
  'Archivo / Evento pasado',
  'Lugar /',
];

test.describe('eyebrow de sección y retorno', () => {
  test('las páginas de sección muestran una etiqueta estática, sin enlace', async ({ page }) => {
    await page.goto('/');
    const agenda = page.locator('.page-hero--agenda .eyebrow');
    await expect(agenda).toHaveText('Agenda');
    await expect(agenda).toHaveCount(1);
    expect(await agenda.evaluate((element) => element.tagName)).toBe('P');

    await page.goto('/lugares/');
    const venues = page.locator('.page-hero--venues .eyebrow');
    await expect(venues).toHaveText('Lugares');
    expect(await venues.evaluate((element) => element.tagName)).toBe('P');

    await page.goto('/acerca-de/');
    const about = page.locator('.page-label .eyebrow');
    await expect(about).toHaveText('Acerca de');
    expect(await about.evaluate((element) => element.tagName)).toBe('P');

    await page.goto('/contacto/');
    const contact = page.locator('.page-label .eyebrow');
    await expect(contact).toHaveText('Contacto');
    expect(await contact.evaluate((element) => element.tagName)).toBe('P');
  });

  test('la ficha de evento vuelve a la agenda', async ({ page }) => {
    await page.goto('/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/');
    const back = page.locator('.event-detail .page-hero a.eyebrow');
    await expect(back).toHaveText(/←\s*Agenda/);
    await expect(back).toHaveAttribute('href', '/');
    await back.click();
    await expect(page).toHaveURL('/');
    await expect(page.locator('.page-hero--agenda .eyebrow')).toHaveText('Agenda');
  });

  test('la ficha de lugar vuelve al índice de lugares', async ({ page }) => {
    await page.goto('/lugares/basilica-pontificia-de-san-miguel/');
    const back = page.locator('.venue-detail .page-hero a.eyebrow');
    await expect(back).toHaveText(/←\s*Lugares/);
    await expect(back).toHaveAttribute('href', '/lugares/');
    await back.click();
    await expect(page).toHaveURL(/\/lugares\/?$/);
    await expect(page.locator('.page-hero--venues .eyebrow')).toHaveText('Lugares');
  });

  test('el eyebrow queda a la misma altura en todas las páginas', async ({ page }) => {
    const viewports = [
      { width: 1440, height: 900 },
      { width: 768, height: 900 },
      { width: 390, height: 844 },
    ] as const;
    const pages = [
      { path: '/', selector: '.page-hero--agenda .eyebrow' },
      { path: '/lugares/', selector: '.page-hero--venues .eyebrow' },
      { path: '/acerca-de/', selector: '.page-label .eyebrow' },
      { path: '/contacto/', selector: '.page-label .eyebrow' },
      { path: '/eventos/trilogia-andaluza/', selector: '.event-detail .page-hero .eyebrow' },
      { path: '/eventos/concierto-de-mineko-kojima/', selector: '.event-detail .page-hero .eyebrow' },
      {
        path: '/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/',
        selector: '.event-detail .page-hero .eyebrow',
      },
      { path: '/lugares/teatro-real/', selector: '.venue-detail .page-hero .eyebrow' },
      { path: '/lugares/basilica-pontificia-de-san-miguel/', selector: '.venue-detail .page-hero .eyebrow' },
      { path: '/pagina-inexistente/', selector: '.error-page .eyebrow' },
    ] as const;

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(pages[0].path);
      await page.evaluate(() => document.fonts.ready);
      const agendaTop = await page.locator(pages[0].selector).evaluate((element) => {
        return element.getBoundingClientRect().top;
      });

      for (const pageCase of pages.slice(1)) {
        await page.goto(pageCase.path);
        await page.evaluate(() => document.fonts.ready);
        const top = await page.locator(pageCase.selector).evaluate((element) => {
          return element.getBoundingClientRect().top;
        });
        expect(top, `${pageCase.path} desalineado a ${viewport.width}px`).toBeCloseTo(agendaTop, 0);
      }
    }
  });

  test('acerca de separa el contenido con la misma línea superior que contacto', async ({ page }) => {
    const rule = async (path: string, selector: string) => {
      await page.goto(path);
      return page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const eyebrow = document.querySelector('.page-label .eyebrow');
        if (!eyebrow) throw new Error('Falta el eyebrow');
        return {
          borderTopWidth: style.borderTopWidth,
          borderTopStyle: style.borderTopStyle,
          borderTopColor: style.borderTopColor,
          width: Math.round(box.width),
          gap: Math.round(box.top - eyebrow.getBoundingClientRect().bottom),
        };
      });
    };

    const contact = await rule('/contacto/', '.page-rule');
    const about = await rule('/acerca-de/', '.page-rule');
    expect(about).toEqual(contact);
  });

  test('no conserva las fórmulas ambiguas anteriores', async ({ page }) => {
    const paths = [
      '/',
      '/lugares/',
      '/acerca-de/',
      '/contacto/',
      '/eventos/excelentia-noches-en-los-jardines-de-espana-y-concierto-de-aranjuez/',
      '/lugares/basilica-pontificia-de-san-miguel/',
    ];
    for (const path of paths) {
      await page.goto(path);
      const body = await page.locator('body').innerText();
      for (const legacy of LEGACY_EYEBROWS) {
        expect(body, `${path} todavía muestra «${legacy}»`).not.toContain(legacy);
      }
    }
  });
});
