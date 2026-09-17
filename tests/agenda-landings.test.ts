import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { madridWeekendRange } from '../src/lib/domain/dates.ts';
import { filterOccurrences, listUpcomingOccurrences, parseAgendaFilters } from '../src/lib/domain/index.ts';
import {
  AGENDA_LANDING_SLUGS,
  agendaLandingFilters,
  agendaLandingLastmods,
  buildAgendaLandingPageModel,
  formatWeekendRangeLabel,
  isAgendaLandingSlug,
  listAgendaLandingSlugs,
} from '../src/lib/presentation/agenda-landings.ts';
import {
  buildAgendaPageModel,
  groupAgendaDays,
  toAgendaItem,
} from '../src/lib/presentation/agenda.ts';
import {
  buildAgendaShortcuts,
  filtersToAgendaHref,
  toggleAgendaShortcut,
} from '../src/lib/presentation/agenda-shortcuts.ts';
import { pageDocumentTitle, SITE_NAME } from '../src/lib/presentation/constants.ts';
import { sitemapLastmodMap, sitemapPageFilter } from '../src/lib/presentation/sitemap.ts';
import { agendaLandingPath } from '../src/lib/presentation/urls.ts';
import { makeCatalog, makeEvent, richCatalog, testClock } from './helpers.ts';

function madridInstant(iso: string): Date {
  return new Date(iso);
}

function weekendCatalog() {
  return makeCatalog({
    events: [
      makeEvent({
        id: 'evt_viernes',
        slug: 'cuarteto-del-viernes',
        title: 'Cuarteto del viernes',
        access: 'paid',
        occurrences: [{ id: 'occ_viernes', date: '2026-09-18', time: '19:30', status: 'scheduled' }],
        lastVerifiedAt: '2026-09-10',
      }),
      makeEvent({
        id: 'evt_sabado',
        slug: 'recital-del-sabado',
        title: 'Recital del sábado',
        access: 'free',
        occurrences: [{ id: 'occ_sabado', date: '2026-09-19', time: '12:00', status: 'scheduled' }],
        lastVerifiedAt: '2026-09-11',
      }),
      makeEvent({
        id: 'evt_domingo',
        slug: 'organo-del-domingo',
        title: 'Órgano del domingo',
        access: 'paid',
        occurrences: [{ id: 'occ_domingo', date: '2026-09-20', time: '18:00', status: 'scheduled' }],
        lastVerifiedAt: '2026-09-12',
      }),
      makeEvent({
        id: 'evt_lunes',
        slug: 'sinfonico-del-lunes',
        title: 'Sinfónico del lunes',
        access: 'free',
        occurrences: [{ id: 'occ_lunes', date: '2026-09-21', time: '19:30', status: 'scheduled' }],
        lastVerifiedAt: '2026-09-13',
      }),
      makeEvent({
        id: 'evt_titulo_gratis',
        slug: 'concierto-gratuito-de-pago',
        title: 'Concierto gratuito de cámara',
        access: 'paid',
        occurrences: [{ id: 'occ_titulo_gratis', date: '2026-09-18', time: '11:00', status: 'scheduled' }],
        lastVerifiedAt: '2026-09-09',
      }),
    ],
  });
}

describe('whitelist de landings SEO', () => {
  it('solo publica gratis y fin-de-semana', () => {
    expect(AGENDA_LANDING_SLUGS).toEqual(['gratis', 'fin-de-semana']);
    expect(listAgendaLandingSlugs()).toEqual(['gratis', 'fin-de-semana']);
    expect(listAgendaLandingSlugs().map(agendaLandingPath)).toEqual([
      '/agenda/gratis/',
      '/agenda/fin-de-semana/',
    ]);
  });

  it('no convierte taxonomías ni query params en landings', () => {
    expect(isAgendaLandingSlug('gratis')).toBe(true);
    expect(isAgendaLandingSlug('fin-de-semana')).toBe(true);
    expect(isAgendaLandingSlug('hoy')).toBe(false);
    expect(isAgendaLandingSlug('opera')).toBe(false);
    expect(isAgendaLandingSlug('zarzuela')).toBe(false);
    expect(isAgendaLandingSlug('musica-de-camara')).toBe(false);
    expect(isAgendaLandingSlug('access=free')).toBe(false);
    expect(isAgendaLandingSlug('gratis?access=free')).toBe(false);
    expect(buildAgendaLandingPageModel(richCatalog(), 'opera', testClock)).toBeNull();
    expect(buildAgendaLandingPageModel(richCatalog(), 'hoy', testClock)).toBeNull();
    expect(
      buildAgendaLandingPageModel(richCatalog(), parseAgendaFilters(new URLSearchParams('access=free')).access ?? '', testClock),
    ).toBeNull();
  });
});

describe('landing /agenda/gratis/', () => {
  it('usa el filtro estructurado access=free, no el texto del título', () => {
    const catalog = weekendCatalog();
    const friday = { now: () => madridInstant('2026-09-18T10:00:00+02:00') };
    const page = buildAgendaLandingPageModel(catalog, 'gratis', friday);
    const items = page?.days.flatMap((day) => day.items) ?? [];
    expect(page?.canonicalPath).toBe('/agenda/gratis/');
    expect(agendaLandingFilters('gratis', friday.now())).toEqual({ access: 'free' });
    expect(items.map((item) => item.title)).toEqual(['Recital del sábado', 'Sinfónico del lunes']);
    expect(items.every((item) => item.access.id === 'free')).toBe(true);
    expect(items.some((item) => item.title.toLowerCase().includes('gratuito'))).toBe(false);

    const viaHomeFilter = filterOccurrences(listUpcomingOccurrences(catalog, friday), { access: 'free' });
    expect(items.map((item) => item.occurrenceId)).toEqual(viaHomeFilter.map((item) => item.occurrence.id));
  });

  it('el recorte de la home con access=free coincide con la landing', () => {
    const catalog = richCatalog();
    const page = buildAgendaLandingPageModel(catalog, 'gratis', testClock);
    const filtered = filterOccurrences(listUpcomingOccurrences(catalog, testClock), { access: 'free' });
    expect(page?.days.flatMap((day) => day.items).map((item) => item.occurrenceId)).toEqual(
      filtered.map((item) => item.occurrence.id),
    );
    expect(filtered.every((item) => item.resolved.event.access === 'free')).toBe(true);
  });
});

describe('landing /agenda/fin-de-semana/', () => {
  it('comparte la ventana del atajo Fin de semana', () => {
    const instants = [
      madridInstant('2026-09-14T10:00:00+02:00'), // lunes
      madridInstant('2026-09-17T10:00:00+02:00'), // jueves
      madridInstant('2026-09-18T10:00:00+02:00'), // viernes
      madridInstant('2026-09-19T10:00:00+02:00'), // sábado
      madridInstant('2026-09-20T10:00:00+02:00'), // domingo
    ];
    for (const now of instants) {
      const landing = agendaLandingFilters('fin-de-semana', now);
      const shortcut = toggleAgendaShortcut({}, 'weekend', now);
      expect(landing).toEqual(madridWeekendRange(now));
      expect(landing).toEqual({ from: shortcut.from, to: shortcut.to });
    }
  });

  it('el viernes incluye viernes, sábado y domingo; el sábado ya no el viernes; el domingo solo el domingo', () => {
    const catalog = weekendCatalog();
    const friday = buildAgendaLandingPageModel(catalog, 'fin-de-semana', {
      now: () => madridInstant('2026-09-18T10:00:00+02:00'),
    });
    const saturday = buildAgendaLandingPageModel(catalog, 'fin-de-semana', {
      now: () => madridInstant('2026-09-19T10:00:00+02:00'),
    });
    const sunday = buildAgendaLandingPageModel(catalog, 'fin-de-semana', {
      now: () => madridInstant('2026-09-20T10:00:00+02:00'),
    });
    expect(friday?.days.flatMap((day) => day.items).map((item) => item.title)).toEqual([
      'Concierto gratuito de cámara',
      'Cuarteto del viernes',
      'Recital del sábado',
      'Órgano del domingo',
    ]);
    expect(saturday?.days.flatMap((day) => day.items).map((item) => item.title)).toEqual([
      'Recital del sábado',
      'Órgano del domingo',
    ]);
    expect(sunday?.days.flatMap((day) => day.items).map((item) => item.title)).toEqual(['Órgano del domingo']);
    expect(friday?.days.some((day) => day.items.some((item) => item.title === 'Sinfónico del lunes'))).toBe(false);
  });

  it('usa el calendario civil de Europe/Madrid, no UTC', () => {
    const stillSaturday = madridInstant('2026-09-19T21:30:00Z');
    const alreadySunday = madridInstant('2026-09-19T22:30:00Z');
    expect(agendaLandingFilters('fin-de-semana', stillSaturday)).toEqual({ from: '2026-09-19', to: '2026-09-20' });
    expect(agendaLandingFilters('fin-de-semana', alreadySunday)).toEqual({ from: '2026-09-20', to: '2026-09-20' });
  });

  it('nombra las fechas concretas del fin de semana mostrado', () => {
    const friday = madridInstant('2026-09-18T10:00:00+02:00');
    const sunday = madridInstant('2026-09-20T10:00:00+02:00');
    const fridayPage = buildAgendaLandingPageModel(weekendCatalog(), 'fin-de-semana', { now: () => friday });
    const sundayPage = buildAgendaLandingPageModel(weekendCatalog(), 'fin-de-semana', { now: () => sunday });
    expect(fridayPage?.intro).toContain(formatWeekendRangeLabel(madridWeekendRange(friday)));
    expect(fridayPage?.intro).toMatch(/18/);
    expect(fridayPage?.intro).toMatch(/20/);
    expect(sundayPage?.intro).toContain(formatWeekendRangeLabel(madridWeekendRange(sunday)));
    expect(sundayPage?.intro).not.toMatch(/18 de septiembre/);
  });
});

describe('canonicals, titles y empty states', () => {
  it('cada landing apunta a sí misma y añade la marca una sola vez', () => {
    const gratis = buildAgendaLandingPageModel(richCatalog(), 'gratis', testClock);
    const weekend = buildAgendaLandingPageModel(richCatalog(), 'fin-de-semana', testClock);
    expect(gratis?.canonicalPath).toBe('/agenda/gratis/');
    expect(weekend?.canonicalPath).toBe('/agenda/fin-de-semana/');
    expect(gratis?.title).toBe('Conciertos gratis de música clásica en Madrid');
    expect(weekend?.title).toBe('Conciertos de música clásica en Madrid este fin de semana');
    expect(gratis?.title).not.toContain(SITE_NAME);
    expect(pageDocumentTitle(gratis?.title ?? '')).toBe(
      'Conciertos gratis de música clásica en Madrid — Clásica Madrid',
    );
    expect(pageDocumentTitle(weekend?.title ?? '')).toBe(
      'Conciertos de música clásica en Madrid este fin de semana — Clásica Madrid',
    );
  });

  it('la home filtrada sigue canonicizando a /', () => {
    const page = buildAgendaPageModel(
      richCatalog(),
      new URL('https://clasicamadrid.com/?access=free&from=2026-09-04&to=2026-09-06'),
      testClock,
    );
    expect(page.canonicalPath).toBe('/');
  });

  it('muestra un empty state útil cuando no hay resultados', () => {
    const empty = buildAgendaLandingPageModel(emptyCatalog(), 'gratis', testClock);
    const noneThisWeekend = buildAgendaLandingPageModel(richCatalog(), 'fin-de-semana', testClock);
    expect(empty?.days).toEqual([]);
    expect(empty?.emptyTitle).toMatch(/gratuitos/i);
    expect(noneThisWeekend?.days).toEqual([]);
    expect(noneThisWeekend?.emptyTitle).toMatch(/fin de semana/i);
    expect(noneThisWeekend?.canonicalPath).toBe('/agenda/fin-de-semana/');
  });

  it('no inyecta el placeholder de hoy vacío de la portada', () => {
    const page = buildAgendaLandingPageModel(richCatalog(), 'gratis', testClock);
    expect(page?.days[0]?.isEmptyToday).not.toBe(true);
    const grouped = groupAgendaDays(
      listUpcomingOccurrences(richCatalog(), testClock)
        .filter((item) => item.resolved.event.access === 'free')
        .map(toAgendaItem),
      testClock.now(),
    );
    expect(grouped.some((day) => day.isEmptyToday)).toBe(false);
  });

  it('describe la página como CollectionPage, no como lista de MusicEvent', () => {
    const page = buildAgendaLandingPageModel(richCatalog(), 'gratis', testClock);
    expect(page?.jsonLd.some((item) => item['@type'] === 'CollectionPage')).toBe(true);
    expect(page?.jsonLd.some((item) => item['@type'] === 'BreadcrumbList')).toBe(true);
    expect(page?.jsonLd.some((item) => item['@type'] === 'MusicEvent')).toBe(false);
    expect(page?.jsonLd[0]).toMatchObject({
      url: 'https://clasicamadrid.com/agenda/gratis/',
    });
  });
});

describe('sitemap de landings', () => {
  it('incluye solo las dos URLs whitelist y no query params', () => {
    expect(sitemapPageFilter('https://clasicamadrid.com/agenda/gratis/')).toBe(true);
    expect(sitemapPageFilter('https://clasicamadrid.com/agenda/fin-de-semana/')).toBe(true);
    expect(sitemapPageFilter('https://clasicamadrid.com/agenda/opera/')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/agenda/hoy/')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/?access=free')).toBe(true);
    const map = sitemapLastmodMap(richCatalog(), testClock.now());
    expect(map.get('/agenda/gratis/')).toBeTruthy();
    expect(map.get('/agenda/fin-de-semana/')).toBe('2026-09-01');
    expect([...map.keys()].some((path) => path.includes('?'))).toBe(false);
    expect(map.has('/agenda/opera/')).toBe(false);
  });

  it('el lastmod de gratis usa lastVerifiedAt de las ocurrencias free próximas', () => {
    const catalog = weekendCatalog();
    const friday = madridInstant('2026-09-18T10:00:00+02:00');
    const lastmods = agendaLandingLastmods(catalog, friday);
    expect(lastmods.get('/agenda/gratis/')).toBe('2026-09-13');
    expect(lastmods.get('/agenda/fin-de-semana/')).toBe('2026-09-18');
  });
});

describe('atajos de la home intactos', () => {
  it('Gratis y Fin de semana siguen siendo query params de /', () => {
    const shortcuts = buildAgendaShortcuts({}, testClock.now());
    expect(shortcuts.map((item) => item.href)).toEqual([
      '/?from=2026-09-04&to=2026-09-06',
      '/?access=free',
    ]);
    expect(shortcuts.every((item) => !item.href.includes('/agenda/'))).toBe(true);
    expect(filtersToAgendaHref({ access: 'free' })).toBe('/?access=free');
    expect(filtersToAgendaHref(madridWeekendRange(testClock.now()))).toBe(
      '/?from=2026-09-04&to=2026-09-06',
    );
  });
});
