import { AGENDA_PATH, VENUES_INDEX_PATH } from './urls.ts';

export type NavItemDefinition = {
  href: string;
  label: string;
  currentWhen?: (path: string) => boolean;
};

export type HeaderLinkModel = {
  href: string;
  label: string;
  current: boolean;
};

export type HeaderNavModel = {
  logoHref: string;
  logoAriaLabel: string;
  agenda: HeaderLinkModel;
  desktopLinks: HeaderLinkModel[];
  secondaryLinks: HeaderLinkModel[];
  mobileMenuLinks: HeaderLinkModel[];
  showMore: boolean;
  moreCurrent: boolean;
  moreLabel: string;
  mobileMenuLabel: string;
};

export type HeaderNavOptions = {
  secondary?: readonly NavItemDefinition[];
};

/** Always visible in the header: Agenda. */
export const AGENDA_NAV: NavItemDefinition = {
  href: AGENDA_PATH,
  label: 'Agenda',
  currentWhen: (path) => path === '/',
};

/**
 * Primary exploration besides Agenda. Visible on desktop; inside the
 * mobile menu.
 */
export const PRIMARY_NAV: readonly NavItemDefinition[] = [
  {
    href: VENUES_INDEX_PATH,
    label: 'Lugares',
    currentWhen: (path) => path === '/lugares' || path.startsWith('/lugares/'),
  },
];

/**
 * Secondary pages grouped under «Más» on desktop and inside the mobile menu.
 * Add a real page here when it exists. «Más» is not rendered while empty.
 */
export const SECONDARY_NAV: readonly NavItemDefinition[] = [];

export const MORE_LABEL = 'Más';
export const MOBILE_MENU_LABEL = 'Menú de secciones';

/** Keep in sync with the `max-width: 620px` header collapse in `global.css`. */
export const NAV_COLLAPSE_QUERY = '(max-width: 620px)';

export function headerNavigation(
  pathname: string,
  options: HeaderNavOptions = {},
): HeaderNavModel {
  const path = normalizePathname(pathname);
  const onAgenda = AGENDA_NAV.currentWhen?.(path) ?? pathMatches(AGENDA_NAV.href, path);
  const secondary = (options.secondary ?? SECONDARY_NAV).map((item) => toLink(item, path));
  const desktopLinks = PRIMARY_NAV.map((item) => toLink(item, path));

  return {
    logoHref: onAgenda ? '#top' : AGENDA_PATH,
    logoAriaLabel: onAgenda
      ? 'Clásica Madrid, ir al comienzo'
      : 'Clásica Madrid, ir a la agenda',
    agenda: {
      href: onAgenda ? '#contenido' : AGENDA_NAV.href,
      label: AGENDA_NAV.label,
      current: onAgenda,
    },
    desktopLinks,
    secondaryLinks: secondary,
    mobileMenuLinks: [...desktopLinks, ...secondary],
    showMore: secondary.length > 0,
    moreCurrent: secondary.some((link) => link.current),
    moreLabel: MORE_LABEL,
    mobileMenuLabel: MOBILE_MENU_LABEL,
  };
}

function toLink(item: NavItemDefinition, path: string): HeaderLinkModel {
  return {
    href: item.href,
    label: item.label,
    current: item.currentWhen ? item.currentWhen(path) : pathMatches(item.href, path),
  };
}

function pathMatches(href: string, path: string): boolean {
  const base = normalizePathname(href);
  if (base === '/') return path === '/';
  return path === base || path.startsWith(`${base}/`);
}

function normalizePathname(pathname: string): string {
  const [raw] = pathname.split(/[?#]/);
  return (raw ?? '').replace(/\/$/, '') || '/';
}
