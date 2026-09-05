import { AGENDA_PATH, VENUES_INDEX_PATH } from './urls.ts';

export type HeaderLinkModel = {
  href: string;
  label: string;
  current: boolean;
};

export type HeaderNavModel = {
  logoHref: string;
  logoAriaLabel: string;
  links: HeaderLinkModel[];
};

export function headerNavigation(pathname: string): HeaderNavModel {
  const path = normalizePathname(pathname);
  const onAgenda = path === '/';
  return {
    logoHref: onAgenda ? '#top' : AGENDA_PATH,
    logoAriaLabel: onAgenda
      ? 'Clásica Madrid, ir al comienzo'
      : 'Clásica Madrid, ir a la agenda',
    links: [
      {
        href: onAgenda ? '#contenido' : AGENDA_PATH,
        label: 'Agenda',
        current: onAgenda,
      },
      {
        href: VENUES_INDEX_PATH,
        label: 'Lugares',
        current: path === '/lugares' || path.startsWith('/lugares/'),
      },
    ],
  };
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/$/, '') || '/';
}
