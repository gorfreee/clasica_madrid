import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_PAGES_PRODUCTION_BRANCH,
  TURNSTILE_TEST_SITE_KEY,
  resolveTurnstileSiteKey,
} from '../src/lib/contact/turnstile-site-key.ts';

const productionKey = '0x4AAAAAAAProductionSiteKey';

describe('resolveTurnstileSiteKey', () => {
  it('usa la site key configurada, también en el build de producción', () => {
    expect(
      resolveTurnstileSiteKey({
        configuredSiteKey: `  ${productionKey}  `,
        cloudflarePages: '1',
        cloudflareBranch: CLOUDFLARE_PAGES_PRODUCTION_BRANCH,
      }),
    ).toBe(productionKey);
  });

  it('usa la site key de prueba en desarrollo, CI y preview si no hay configuración', () => {
    expect(resolveTurnstileSiteKey({})).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(
      resolveTurnstileSiteKey({
        cloudflarePages: '1',
        cloudflareBranch: 'feat/contact-page',
      }),
    ).toBe(TURNSTILE_TEST_SITE_KEY);
  });

  it('falla el build de producción de Cloudflare Pages si falta la site key', () => {
    expect(() =>
      resolveTurnstileSiteKey({
        configuredSiteKey: '   ',
        cloudflarePages: '1',
        cloudflareBranch: CLOUDFLARE_PAGES_PRODUCTION_BRANCH,
      }),
    ).toThrow(/PUBLIC_TURNSTILE_SITE_KEY/);
  });
});
