import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromMadridLocal } from '../src/lib/domain/dates.ts';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { sitemapPageFilter } from '../src/lib/presentation/sitemap.ts';
import { eventPath, eventOccurrenceIcsPath, eventUrl } from '../src/lib/presentation/urls.ts';
import {
  buildCalendarAction,
  buildCalendarLocation,
  calendarChangeNote,
  calendarCitationUrl,
  calendarDescription,
  CALENDAR_UNCONFIRMED_TIME_NOTE,
  escapeIcsText,
  googleCalendarUrl,
  listCalendarStaticPaths,
  madridUtcStamp,
  renderIcs,
  selectCalendarOccurrences,
  verificationStamp,
  type CalendarOccurrence,
  type CalendarSource,
} from '../src/lib/presentation/calendar.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, TEST_NOW, testClock } from './helpers.ts';

const PAST_NOW = new Date('2020-01-01T12:00:00Z');

function source(overrides: Partial<CalendarSource> = {}): CalendarSource {
  return {
    id: 'evt_demo',
    slug: 'demo',
    title: 'Demo',
    status: 'scheduled',
    lastVerifiedAt: '2026-08-20',
    venueName: 'Teatro Real',
    spaceName: null,
    address: null,
    municipality: 'Madrid',
    occurrences: [{ id: 'occ_demo', date: '2026-10-18', time: '19:30', status: 'scheduled' }],
    ...overrides,
  };
}

function one(overrides: Partial<CalendarSource> = {}, now = PAST_NOW): CalendarOccurrence {
  const [occurrence] = selectCalendarOccurrences(source(overrides), now);
  if (!occurrence) throw new Error('se esperaba una ocurrencia de calendario');
  return occurrence;
}

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '');
}

function unescapeIcs(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === 'n' || next === 'N') out += '\n';
      else out += next ?? '';
      index += 1;
    } else {
      out += value[index];
    }
  }
  return out;
}

function textProperty(ics: string, name: string): string {
  const line = unfold(ics)
    .split('\r\n')
    .find((item) => item.startsWith(`${name}:`));
  if (!line) throw new Error(`falta ${name}`);
  return unescapeIcs(line.slice(name.length + 1));
}

function expectCrLf(ics: string) {
  expect(ics.endsWith('\r\n')).toBe(true);
  expect(ics.replaceAll('\r\n', '')).not.toContain('\n');
  expect(ics.replaceAll('\r\n', '')).not.toContain('\r');
  for (const line of ics.split('\r\n')) {
    if (!line) continue;
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  }
}

describe('selección de ocurrencias', () => {
  it('ofrece la única función futura directamente', () => {
    const action = buildCalendarAction(source(), PAST_NOW);
    expect(action?.occurrences).toHaveLength(1);
    expect(action?.occurrences[0]?.id).toBe('occ_demo');
    expect(action?.occurrences[0]?.hasConfirmedTime).toBe(true);
    expect(action?.occurrences[0]?.icsPath).toBe('/eventos/demo/occ_demo.ics');
    expect(action?.occurrences[0]?.icsPath.endsWith('/')).toBe(false);
  });

  it('pide elegir cuando hay varias funciones futuras y no descarta las demás', () => {
    const action = buildCalendarAction(
      source({
        occurrences: [
          { id: 'occ_b', date: '2026-10-06', time: '20:00', status: 'scheduled' },
          { id: 'occ_a', date: '2026-10-05', time: '19:00', status: 'scheduled' },
          { id: 'occ_c', date: '2026-10-05', time: null, status: 'scheduled' },
        ],
      }),
      PAST_NOW,
    );
    expect(action?.occurrences.map((item) => item.id)).toEqual(['occ_a', 'occ_c', 'occ_b']);
    expect(action?.occurrences[1]?.hasConfirmedTime).toBe(false);
    expect(action?.occurrences[1]?.timeLabel).toBe('Hora por confirmar');
  });

  it('excluye canceladas, pasadas y eventos cancelados o aplazados', () => {
    const now = new Date('2026-09-15T16:00:00Z');
    const occurrences = [
      { id: 'occ_past', date: '2026-09-14', time: '19:00', status: 'scheduled' as const },
      { id: 'occ_earlier', date: '2026-09-15', time: '12:00', status: 'scheduled' as const },
      { id: 'occ_later', date: '2026-09-15', time: '19:30', status: 'scheduled' as const },
      { id: 'occ_open', date: '2026-09-15', time: null, status: 'scheduled' as const },
      { id: 'occ_cancelled', date: '2026-09-20', time: '19:00', status: 'cancelled' as const },
    ];
    expect(selectCalendarOccurrences(source({ occurrences }), now).map((item) => item.id)).toEqual([
      'occ_later',
      'occ_open',
    ]);
    expect(selectCalendarOccurrences(source({ status: 'cancelled', occurrences }), now)).toEqual([]);
    expect(selectCalendarOccurrences(source({ status: 'postponed', occurrences }), now)).toEqual([]);
    expect(buildCalendarAction(source({ occurrences: [occurrences[0]!] }), now)).toBeNull();
  });

  it('la ficha publicada solo enlaza funciones que también tienen .ics', () => {
    const upcoming = buildEventPageModel(makeCatalog(), 'matinees-de-otono', testClock);
    expect(upcoming?.calendar?.occurrences.map((item) => item.id)).toEqual(['occ_matinees_1']);
    expect(upcoming?.canonicalPath).toBe('/eventos/matinees-de-otono/');
    expect(upcoming?.canonicalPath).not.toContain('utm_');
    expect(JSON.stringify(upcoming?.jsonLd)).not.toContain('utm_source');
    expect(eventUrl('matinees-de-otono')).not.toContain('utm_');

    const carmen = buildEventPageModel(richCatalog(), 'carmen', testClock);
    expect(carmen?.calendar?.occurrences.map((item) => item.id)).toEqual(['occ_carmen_1', 'occ_carmen_3']);

    const past = buildEventPageModel(richCatalog(), 'concierto-de-verano', testClock);
    expect(past?.isPast).toBe(true);
    expect(past?.calendar).toBeNull();

    const paths = listCalendarStaticPaths(richCatalog(), TEST_NOW);
    expect(paths.map((item) => item.params.occurrenceId).sort()).toEqual([
      'occ_carmen_1',
      'occ_carmen_3',
      'occ_matinees_1',
      'occ_organo_1',
    ]);
    expect(paths.some((item) => item.params.occurrenceId === 'occ_carmen_2')).toBe(false);
    expect(listCalendarStaticPaths(makeCatalog({ events: [makeEvent({ status: 'cancelled' })] }), TEST_NOW)).toEqual(
      [],
    );
    expect(listCalendarStaticPaths(makeCatalog({ events: [makeEvent({ status: 'postponed' })] }), TEST_NOW)).toEqual(
      [],
    );
  });

  it('no incluye los .ics en el sitemap', () => {
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/occ_carmen_1.ics')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/occ_carmen_1.ics/')).toBe(false);
    expect(sitemapPageFilter('https://clasicamadrid.com/eventos/carmen/')).toBe(true);
    const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
    expect(headers).toContain('/eventos/*/*.ics');
    expect(headers).toContain('Content-Type: text/calendar; charset=utf-8');
    expect(headers).toContain('Content-Disposition: attachment');
  });
});

describe('ubicación', () => {
  it('compone sala, lugar y dirección sin repetir el municipio', () => {
    expect(
      buildCalendarLocation({
        spaceName: 'Sala de Cámara',
        venueName: 'Auditorio Nacional de Música',
        address: 'Príncipe de Vergara 146, Madrid',
        municipality: 'Madrid',
      }),
    ).toBe('Sala de Cámara · Auditorio Nacional de Música, Príncipe de Vergara 146, Madrid');
    expect(
      buildCalendarLocation({
        spaceName: null,
        venueName: 'Teatro Real',
        address: null,
        municipality: 'Madrid',
      }),
    ).toBe('Teatro Real, Madrid');
    expect(
      buildCalendarLocation({
        spaceName: 'Auditorio',
        venueName: 'Auditorio',
        address: 'Calle Mayor 1',
        municipality: 'Madrid',
      }),
    ).toBe('Auditorio, Calle Mayor 1, Madrid');
  });

  it('usa la sala interna y la dirección del lugar principal', () => {
    const room = makeVenue({
      id: 'ven_sala_camara',
      slug: 'auditorio-nacional-sala-de-camara',
      name: 'Sala de Cámara',
      spaceName: 'Sala de Cámara',
      parentVenueId: 'ven_auditorio_nacional',
      address: undefined,
    });
    const page = buildEventPageModel(
      makeCatalog({
        venues: [makeVenue(), room],
        events: [makeEvent({ venueId: 'ven_sala_camara' })],
      }),
      'matinees-de-otono',
      testClock,
    );
    const href = page?.calendar?.occurrences[0]?.googleHref ?? '';
    expect(new URL(href).searchParams.get('location')).toBe(
      'Sala de Cámara · Auditorio Nacional de Música, Príncipe de Vergara, 146, Madrid',
    );
  });
});

describe('Google Calendar', () => {
  it('usa la hora civil de Madrid y el mismo instante como fin', () => {
    const href = googleCalendarUrl(one());
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect([...url.searchParams.keys()].sort()).toEqual(['action', 'ctz', 'dates', 'details', 'location', 'text']);
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('ctz')).toBe('Europe/Madrid');
    expect(url.searchParams.get('text')).toBe('Demo');
    expect(url.searchParams.get('dates')).toBe('20261018T193000/20261018T193000');
    expect(url.searchParams.get('dates')).not.toContain('Z');
    expect(href).not.toMatch(/\+0[12]:00/);
    expect(url.searchParams.get('location')).toBe('Teatro Real, Madrid');
    const details = url.searchParams.get('details') ?? '';
    expect(details).toBe(calendarDescription(true, calendarCitationUrl(eventPath('demo'), 'google_calendar')));
    expect(details).toContain('utm_source=google_calendar');
    expect(details).toContain('utm_medium=calendar');
    expect(details).not.toContain('utm_source=ics');
    expect(url.searchParams.get('utm_source')).toBeNull();
  });

  it('guarda un día completo cuando la hora no está confirmada', () => {
    const href = googleCalendarUrl(one({ occurrences: [{ id: 'occ_demo', date: '2026-10-31', time: null, status: 'scheduled' }], title: 'Recital' }));
    const url = new URL(href);
    expect(url.searchParams.get('text')).toBe('Recital — hora por confirmar');
    expect(url.searchParams.get('dates')).toBe('20261031/20261101');
    expect(url.searchParams.get('dates')).not.toContain('T');
    const details = url.searchParams.get('details') ?? '';
    expect(details.startsWith(CALENDAR_UNCONFIRMED_TIME_NOTE)).toBe(true);
    expect(details).toContain(calendarChangeNote(calendarCitationUrl('/eventos/demo/', 'google_calendar')));
    expect(details).not.toMatch(/T\d{6}/);
  });

  it('conserva caracteres especiales sin inventar duración', () => {
    const title = 'Vivaldi & Paganini, "A"; ruta \\ B';
    const href = googleCalendarUrl(
      one({
        title,
        address: 'Calle de Alcalá, 13',
        occurrences: [{ id: 'occ_demo', date: '2026-07-15', time: '20:00', status: 'scheduled' }],
      }),
    );
    const url = new URL(href);
    expect(url.searchParams.get('text')).toBe(title);
    const [start, end] = (url.searchParams.get('dates') ?? '').split('/');
    expect(end).toBe(start);
    expect(start).toBe('20260715T200000');
    expect(url.searchParams.get('location')).toContain('Alcalá');
    expect(url.searchParams.get('details')).not.toContain('<');
    expect(url.searchParams.get('details')).not.toContain('&amp;');
  });
});

describe('iCalendar', () => {
  it('describe una función con hora conocida, sin fin inventado', () => {
    const ics = renderIcs(one({ title: 'Cita & sala' }));
    expectCrLf(ics);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:-//clasicamadrid.com//Calendario//ES');
    expect(ics).toContain('CALSCALE:GREGORIAN');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:occ_demo@clasicamadrid.com');
    expect(ics).toContain(`DTSTAMP:${verificationStamp('2026-08-20')}`);
    expect(ics).toContain('DTSTART:20261018T173000Z');
    expect(ics).not.toContain('DTEND');
    expect(ics).not.toContain('VTIMEZONE');
    expect(ics).not.toContain('LAST-MODIFIED');
    expect(ics).not.toContain('+01');
    expect(ics).not.toContain('+02');
    expect(textProperty(ics, 'SUMMARY')).toBe('Cita & sala');
    expect(textProperty(ics, 'SUMMARY')).not.toContain('Clásica Madrid');
    expect(textProperty(ics, 'LOCATION')).toBe('Teatro Real, Madrid');
    const citation = calendarCitationUrl(eventPath('demo'), 'ics');
    expect(textProperty(ics, 'DESCRIPTION')).toBe(calendarDescription(true, citation));
    expect(textProperty(ics, 'URL')).toBe(citation);
    expect(citation).toContain('utm_source=ics');
    expect(citation).toContain('utm_medium=calendar');
    expect(ics).not.toContain('utm_source=google_calendar');
    expect(ics).not.toContain('<');
    expect(ics).not.toContain('&amp;');
    expect(ics).not.toContain('undefined');
    expect(ics).not.toContain('null');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('trata la hora desconocida como día completo', () => {
    const ics = renderIcs(
      one({
        title: 'Festival Alicia',
        occurrences: [{ id: 'occ_demo', date: '2026-10-10', time: null, status: 'scheduled' }],
      }),
    );
    expect(ics).toContain('DTSTART;VALUE=DATE:20261010');
    expect(ics).not.toMatch(/DTSTART:/);
    expect(ics).not.toContain('DTEND');
    expect(textProperty(ics, 'SUMMARY')).toBe('Festival Alicia — hora por confirmar');
    expect(textProperty(ics, 'DESCRIPTION').startsWith(CALENDAR_UNCONFIRMED_TIME_NOTE)).toBe(true);
    expect(textProperty(ics, 'DESCRIPTION')).toContain('\n\n');
    expect(ics).not.toMatch(/T(?:000000|120000|200000)(?!Z)/);
  });

  it('mantiene un UID estable aunque cambie el slug y puede marcar una cancelación', () => {
    const left = one({ slug: 'nombre-antiguo' });
    const right = one({ slug: 'nombre-nuevo' });
    expect(left.uid).toBe('occ_demo@clasicamadrid.com');
    expect(right.uid).toBe(left.uid);
    expect(renderIcs(left)).toContain('UID:occ_demo@clasicamadrid.com');
    expect(renderIcs(left)).not.toContain('UID:nombre-antiguo');
    const cancelled = renderIcs({ ...left, status: 'cancelled' });
    expect(cancelled).toContain('STATUS:CANCELLED');
    expect(renderIcs(left)).not.toContain('STATUS:');
  });

  it('escapa coma, punto y coma, barra invertida y saltos de línea', () => {
    const raw = 'A\\B, C; D\nE';
    expect(escapeIcsText(raw)).toBe('A\\\\B\\, C\\; D\\nE');
    const ics = renderIcs(
      one({
        title: raw,
        address: 'Norte \\ 1, Madrid; sala',
        municipality: 'Madrid',
      }),
    );
    expect(textProperty(ics, 'SUMMARY')).toBe(raw);
    expect(textProperty(ics, 'LOCATION')).toContain('Norte \\ 1, Madrid; sala');
    expect(ics).not.toContain('<br');
  });

  it('pliega líneas largas sin cortar un carácter UTF-8', () => {
    const title = `${'á'.repeat(80)}, sala; \\ fin`;
    const ics = renderIcs(one({ title, venueName: 'Ñandú '.repeat(20).trim() }));
    expectCrLf(ics);
    expect(textProperty(ics, 'SUMMARY')).toBe(title);
    expect(ics).toContain('\r\n ');
    expect(Buffer.byteLength('á', 'utf8')).toBe(2);
  });

  it('convierte invierno, verano y los cambios de hora de Madrid', () => {
    expect(madridUtcStamp('2026-01-15', '20:00')).toBe('20260115T190000Z');
    expect(madridUtcStamp('2026-07-15', '20:00')).toBe('20260715T180000Z');
    expect(madridUtcStamp('2026-03-28', '20:00')).toBe('20260328T190000Z');
    expect(madridUtcStamp('2026-03-29', '20:00')).toBe('20260329T180000Z');
    expect(madridUtcStamp('2026-10-24', '20:00')).toBe('20261024T180000Z');
    expect(madridUtcStamp('2026-10-25', '20:00')).toBe('20261025T190000Z');
    expect(renderIcs(one({ occurrences: [{ id: 'occ_demo', date: '2026-01-15', time: '20:00', status: 'scheduled' }] }))).toContain(
      'DTSTART:20260115T190000Z',
    );
    expect(renderIcs(one({ occurrences: [{ id: 'occ_demo', date: '2026-07-15', time: '20:00', status: 'scheduled' }] }))).toContain(
      'DTSTART:20260715T180000Z',
    );

    expect(fromMadridLocal('2026-10-25', '02:30').toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(madridUtcStamp('2026-10-25', '02:30')).toBe('20261025T013000Z');
    const gap = fromMadridLocal('2026-03-29', '02:30');
    expect(gap.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(madridUtcStamp('2026-03-29', '02:30')).toBe('20260329T013000Z');
    const wall = gap.toLocaleTimeString('en-GB', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(wall).toBe('03:30');
  });
});

describe('rutas', () => {
  it('no añade barra final al archivo', () => {
    expect(eventOccurrenceIcsPath('demo', 'occ_demo')).toBe('/eventos/demo/occ_demo.ics');
    expect(eventPath('demo')).toBe('/eventos/demo/');
  });
});
