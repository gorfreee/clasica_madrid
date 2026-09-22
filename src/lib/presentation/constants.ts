export const SITE_ORIGIN = 'https://clasicamadrid.com';
export const SITE_NAME = 'Clásica Madrid';
export const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbDMlLw5Ejy6w8hyme2J';
export const DEFAULT_TITLE = 'Clásica Madrid — Agenda de música clásica en Madrid';
export const DEFAULT_DESCRIPTION =
  'Agenda pública de conciertos y eventos de música clásica en Madrid y su entorno inmediato.';
export const HOME_TITLE = 'Conciertos de música clásica en Madrid';
export const HOME_DESCRIPTION =
  'Agenda de conciertos de música clásica en Madrid, de las grandes salas a los pequeños espacios. Fechas, lugares, intérpretes, compositores y conciertos gratuitos.';
export const BRAND_BLUE = '#0055A0';
export const SITE_BACKGROUND = '#f1efe8';
export const DEFAULT_SOCIAL_IMAGE_PATH = '/brand/clasica-madrid-social-card.png';
export const DEFAULT_SOCIAL_IMAGE_ALT = 'Clásica Madrid — Agenda de música clásica en Madrid';

/** Document `<title>` / og:title. Layout appends the brand unless it is already present. */
export function pageDocumentTitle(title: string): string {
  return title === DEFAULT_TITLE || title.includes(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
}
