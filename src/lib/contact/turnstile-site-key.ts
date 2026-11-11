/** Official Cloudflare Turnstile site key that always returns a passing token. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

/** Branch Cloudflare Pages publishes as the production deployment. */
export const CLOUDFLARE_PAGES_PRODUCTION_BRANCH = 'main';

export type TurnstileSiteKeyInput = {
  configuredSiteKey?: string;
  cloudflarePages?: string;
  cloudflareBranch?: string;
};

export function resolveTurnstileSiteKey(input: TurnstileSiteKeyInput): string {
  const configured = input.configuredSiteKey?.trim() ?? '';
  if (configured) return configured;

  const productionPagesBuild =
    input.cloudflarePages === '1' && input.cloudflareBranch === CLOUDFLARE_PAGES_PRODUCTION_BRANCH;

  if (productionPagesBuild) {
    throw new Error(
      'Falta PUBLIC_TURNSTILE_SITE_KEY en el build de producción de Cloudflare Pages. ' +
        'Define la site key real del widget antes de publicar. La site key de prueba de Turnstile ' +
        'solo se usa en desarrollo, tests locales y deployments preview.',
    );
  }

  return TURNSTILE_TEST_SITE_KEY;
}
