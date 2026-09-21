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

    await expect(page.getByRole('heading', { level: 1, name: 'Escríbenos' })).toBeVisible();
    await expect(page.getByLabel('Nombre (opcional)')).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('required', '');
    await expect(page.getByLabel('Motivo')).toHaveAttribute('required', '');
    await expect(page.getByRole('textbox', { name: 'Mensaje', exact: true })).toHaveAttribute(
      'required',
      '',
    );
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
    await expect(panel.getByRole('link')).toHaveText(['Acerca de', 'Contacto']);
    await expect(panel.getByRole('link', { name: 'Contacto' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('el menú móvil conserva Lugares, Acerca de y Contacto en ese orden', async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/contacto/');

    await page.getByRole('button', { name: 'Menú de secciones' }).click();
    const panel = page.locator('#nav-mobile-panel');
    await expect(panel.getByRole('link')).toHaveText(['Lugares', 'Acerca de', 'Contacto']);
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
    await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
    await page.getByLabel('Motivo').selectOption('Corrección');
    await page
      .getByRole('textbox', { name: 'Mensaje', exact: true })
      .fill('Hay una hora incorrecta.');
    const submit = page.getByRole('button', { name: 'Enviar mensaje' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole('status')).toHaveText('Gracias. Tu mensaje se ha enviado.');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
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

    await page.getByLabel('Email', { exact: true }).fill('ana@example.com');
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
});

declare global {
  interface Window {
    __turnstileResets: number;
  }
}
