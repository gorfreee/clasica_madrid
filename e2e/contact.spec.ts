import { expect, test, type Page } from '@playwright/test';

async function stubTurnstile(page: Page) {
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js**', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        (() => {
          let callback;
          window.__turnstileResets = 0;
          window.turnstile = {
            render(_container, options) {
              callback = options.callback;
              setTimeout(() => callback('e2e-turnstile-token'), 0);
              return 'contact-widget';
            },
            reset() {
              window.__turnstileResets += 1;
              setTimeout(() => callback('e2e-renewed-token'), 0);
            },
          };
        })();
      `,
    });
  });
}

test.describe('página de contacto', () => {
  test('renderiza el formulario accesible, email directo y canonical', async ({ page }) => {
    await stubTurnstile(page);
    await page.goto('/contacto/');

    await expect(page.getByRole('heading', { level: 1, name: 'Envíanos un mensaje' })).toBeVisible();
    await expect(page.locator('.page-label .eyebrow')).toHaveText('Contacto');
    await expect(page.locator('[data-hero-motif]')).toHaveCount(0);
    await expect(page.getByLabel('Nombre (opcional)')).toHaveAttribute('placeholder', 'Tu nombre');
    const email = page.getByLabel('Email (opcional)');
    await expect(email).not.toHaveAttribute('required', '');
    await expect(email).toHaveAttribute('placeholder', 'tu@email.com');
    await expect(email).toHaveAttribute('aria-describedby', 'contact-email-help');
    await expect(page.locator('#contact-email-help')).toHaveText(
      'Si quieres recibir una respuesta, déjanos tu email.',
    );
    await expect(page.getByLabel('Motivo')).toHaveAttribute('required', '');
    const message = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await expect(message).toHaveAttribute('required', '');
    await expect(message).toHaveAttribute('placeholder', 'Cuéntanos en qué podemos ayudarte…');
    await expect(page.locator('form[data-contact-form]')).toHaveAttribute('action', '/api/contacto');
    await expect(page.locator('form[data-contact-form]')).toHaveAttribute('method', 'post');
    await expect(page.getByRole('link', { name: 'hola@clasicamadrid.com' })).toHaveAttribute(
      'href',
      'mailto:hola@clasicamadrid.com',
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'https://clasicamadrid.com/contacto/',
    );
  });

  test('nombre y email quedan alineados en escritorio', async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/contacto/');

    for (const width of [1280, 800]) {
      await page.setViewportSize({ width, height: 800 });
      const name = await page.getByLabel('Nombre (opcional)').boundingBox();
      const email = await page.getByLabel('Email (opcional)').boundingBox();
      expect(name).toBeTruthy();
      expect(email).toBeTruthy();
      expect(Math.abs(name!.y - email!.y)).toBeLessThan(1);
      expect(Math.abs(name!.height - email!.height)).toBeLessThan(1);
    }
  });

  test('no desborda en móvil', async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/contacto/');

    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBe(widths.client);
    await expect(page.getByRole('button', { name: 'Enviar mensaje' })).toBeVisible();
  });

  test('Contacto aparece en Más y queda activo en escritorio', async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/contacto/');

    const more = page.getByRole('button', { name: 'Más' });
    await expect(more).toHaveAttribute('aria-current', 'true');
    await more.click();
    const panel = page.locator('#nav-more-panel');
    await expect(panel.getByRole('link')).toHaveText(['Contacto', 'Acerca de']);
    await expect(panel.getByRole('link', { name: 'Contacto' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('el menú móvil deja Acerca de al final', async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contacto/');

    await page.getByRole('button', { name: 'Menú de secciones' }).click();
    const panel = page.locator('#nav-mobile-panel');
    await expect(panel.getByRole('link')).toHaveText(['Lugares', 'Contacto', 'Acerca de']);
    await expect(panel.getByRole('link', { name: 'Contacto' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('muestra éxito sin recargar y renueva el token', async ({ page }) => {
    await stubTurnstile(page);
    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, message: 'Gracias. Tu mensaje se ha enviado.' }),
      });
    });
    await page.goto('/contacto/');

    await page.getByLabel('Nombre (opcional)').fill('Ana');
    await page.getByLabel('Email (opcional)').fill('ana@example.com');
    await page.getByLabel('Motivo').selectOption('Corrección');
    await page
      .getByRole('textbox', { name: 'Mensaje', exact: true })
      .fill('Hay una hora incorrecta.');
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole('status')).toHaveText('Gracias. Tu mensaje se ha enviado.');
    await expect(page.getByLabel('Email (opcional)')).toHaveValue('');
    await expect.poll(() => page.evaluate(() => window.__turnstileResets)).toBe(1);
    await expect(submit).toBeEnabled();
  });

  test('muestra un error útil y permite reintentar con un token nuevo', async ({ page }) => {
    await stubTurnstile(page);
    await page.route('**/api/contacto', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false }),
      });
    });
    await page.goto('/contacto/');

    await page.getByLabel('Email (opcional)').fill('ana@example.com');
    await page.getByLabel('Motivo').selectOption('Otro');
    await page
      .getByRole('textbox', { name: 'Mensaje', exact: true })
      .fill('Mensaje de prueba.');
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole('status')).toHaveText(
      'No hemos podido enviar el mensaje. Puedes escribirnos a hola@clasicamadrid.com.',
    );
    await expect.poll(() => page.evaluate(() => window.__turnstileResets)).toBe(1);
    await expect(submit).toBeEnabled();
  });

  test('envía un mensaje válido sin email', async ({ page }) => {
    await stubTurnstile(page);
    const bodies: string[] = [];
    await page.route('**/api/contacto', async (route) => {
      bodies.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, message: 'Gracias. Tu mensaje se ha enviado.' }),
      });
    });
    await page.goto('/contacto/');

    await page.getByLabel('Motivo').selectOption('Añadir un concierto');
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Falta un concierto en la agenda.');
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole('status')).toHaveText('Gracias. Tu mensaje se ha enviado.');
    expect(bodies).toHaveLength(1);
    const params = new URLSearchParams(bodies[0]);
    expect(params.get('email')).toBe('');
    expect(params.get('motivo')).toBe('Añadir un concierto');
    expect(params.get('cf-turnstile-response')).toBe('e2e-turnstile-token');
  });

  test('no envía un email con formato inválido', async ({ page }) => {
    await stubTurnstile(page);
    await page.goto('/contacto/');

    const email = page.getByLabel('Email (opcional)');
    await email.fill('no-es-un-email');
    await page.getByLabel('Motivo').selectOption('Otro');
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Mensaje de prueba.');
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    const request = page.waitForRequest('**/api/contacto', { timeout: 1_000 }).catch(() => null);
    await submit.click();

    await expect(email).toHaveJSProperty('validity.valid', false);
    expect(await request).toBeNull();
    await expect(page.getByRole('status')).toHaveText('');
    await expect(submit).toHaveText('Enviar mensaje');
  });
});

declare global {
  interface Window {
    __turnstileResets: number;
  }
}
