import { expect, test } from '@playwright/test';

const donationUrl = 'https://donate.stripe.com/aFa4gzfTZdwQaAF2NvfIs00';

test('el footer lleva a la sección de apoyo con foco visible y sin desbordamiento', async ({ page }) => {
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/');
    const footerLink = page.getByRole('contentinfo').getByRole('link', { name: 'Apoya el proyecto' });
    await footerLink.focus();
    expect(await footerLink.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await footerLink.click();
    await expect(page).toHaveURL(/\/acerca-de\/#apoya$/);
    await expect(page.getByRole('region', { name: 'Que ningún concierto se quede fuera' })).toBeInViewport();
    const action = page.locator('[data-donation="about"]');
    await expect(action).toHaveAttribute('href', donationUrl);
    await action.focus();
    expect(await action.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
    const bounds = await action.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('el apoyo abre Stripe y registra una intención sin datos de pago', async ({ page }) => {
  await page.addInitScript(() => {
    const events: unknown[] = [];
    (window as unknown as { __supportEvents: unknown[] }).__supportEvents = events;
    Object.defineProperty(window, 'posthog', {
      configurable: true,
      value: { capture: (event: string, properties: unknown) => events.push({ event, properties }) },
    });
  });
  await page.context().route('https://donate.stripe.com/**', (route) => route.fulfill({ body: 'Checkout de prueba' }));
  await page.goto('/acerca-de/');
  const action = page.getByRole('link', { name: /Apoyar Clásica Madrid en Stripe/ });
  await expect(action).toHaveAttribute('target', '_blank');
  await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
  const [popup] = await Promise.all([page.waitForEvent('popup'), action.click()]);
  await expect(popup).toHaveURL(donationUrl);
  await popup.close();
  await expect(page).toHaveURL(/\/acerca-de\/$/);
  const donations = await page.evaluate(() =>
    (window as unknown as { __supportEvents: { event: string }[] }).__supportEvents
      .filter(({ event }) => event === 'donation_clicked'),
  );
  expect(donations).toEqual([
    { event: 'donation_clicked', properties: { placement: 'about', page_type: 'about', provider: 'stripe' } },
  ]);
});

test('el enlace de apoyo funciona sin JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.route('https://donate.stripe.com/**', (route) => route.fulfill({ body: 'Checkout de prueba' }));
  const page = await context.newPage();
  await page.goto('http://localhost:4321/acerca-de/#apoya');
  const action = page.getByRole('link', { name: /Apoyar Clásica Madrid en Stripe/ });
  await expect(action).toBeVisible();
  await action.focus();
  await expect(action).toBeFocused();
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    action.press('Enter'),
  ]);
  await expect(popup).toHaveURL(donationUrl);
  await expect(page).toHaveURL(/\/acerca-de\/#apoya$/);
  await context.close();
});
