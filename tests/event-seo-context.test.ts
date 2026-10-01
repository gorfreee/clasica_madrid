import { describe, expect, it } from 'vitest';
import { buildEventPageModel } from '../src/lib/presentation/event.ts';
import { buildEventDocumentTitles, eventDocumentTitle, EVENT_DESCRIPTION_MAX_LENGTH } from '../src/lib/presentation/event-seo.ts';
import { listCanonicalEvents } from '../src/lib/domain/index.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { makeCatalog, makeEvent, makeVenue, richCatalog, testClock } from './helpers.ts';

function repeatedEvent(id: string, date: string, time: string | null = '19:30') {
  return makeEvent({ id, slug: id, title: 'Mismo concierto',
    occurrences: [{ id: `occ_${id}`, date, time, status: 'scheduled' }] });
}

const room = (id: string, spaceName: string) => makeVenue({
  id, slug: id, name: spaceName, parentVenueId: makeVenue().id, spaceName,
});

describe('diferenciación factual de fichas', () => {
  it('desambigua fechas sin tocar H1, identidad, aliases ni datos estructurados', () => {
    const events = [repeatedEvent('evt_a', '2026-10-28'), repeatedEvent('evt_b', '2026-10-29')];
    events[0]!.slugAliases = ['alias-anterior'];
    const catalog = makeCatalog({ events });
    const before = JSON.stringify(catalog);
    const a = buildEventPageModel(catalog, 'evt_a', testClock)!;
    const b = buildEventPageModel(catalog, 'evt_b', testClock)!;
    expect(a.documentTitle).toBe('Mismo concierto · 28 oct 2026 · Auditorio Nacional de Música');
    expect(b.documentTitle).toBe('Mismo concierto · 29 oct 2026 · Auditorio Nacional de Música');
    expect(a.title).toBe(events[0]!.title);
    expect(b.title).toBe(events[1]!.title);
    expect(buildEventPageModel(catalog, 'alias-anterior', testClock)?.documentTitle).toBe(a.documentTitle);
    expect(a.jsonLd.filter((item) => item['@type'] === 'MusicEvent')).toHaveLength(1);
    expect(a.jsonLd[0]).toMatchObject({ name: 'Mismo concierto', startDate: '2026-10-28T19:30:00+01:00' });
    expect(a.jsonLd[0]).not.toHaveProperty('offers');
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('usa hora y sala solo cuando la fecha aún colisiona', () => {
    const catalog = makeCatalog({ venues: [makeVenue(), room('ven_a', 'Sala A'), room('ven_b', 'Sala B')],
      events: [
        { ...repeatedEvent('evt_a', '2026-10-28', '18:00'), venueId: 'ven_a' },
        { ...repeatedEvent('evt_b', '2026-10-28', '20:00'), venueId: 'ven_a' },
        { ...repeatedEvent('evt_c', '2026-10-28', '20:00'), venueId: 'ven_b' },
      ] });
    const titles = catalog.events.map((event) => buildEventPageModel(catalog, event.slug, testClock)!.documentTitle);
    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toContain('28 oct 2026 · 18:00');
    expect(titles[0]).not.toContain('Sala A');
    expect(titles[1]).toContain('20:00 · Sala A');
    expect(titles[2]).toContain('20:00 · Sala B');
  });

  it('usa hechos musicales para fechas, horas y salas iguales sin IDs técnicos', () => {
    const catalog = makeCatalog({ events: [
      { ...repeatedEvent('evt_a', '2026-10-28'), composers: [{ name: 'Brahms' }] },
      { ...repeatedEvent('evt_b', '2026-10-28'), composers: [{ name: 'Sibelius' }] },
    ] });
    const a = buildEventPageModel(catalog, 'evt_a', testClock)!;
    const b = buildEventPageModel(catalog, 'evt_b', testClock)!;
    expect(a.documentTitle).not.toBe(b.documentTitle);
    expect(a.documentTitle).toContain('Brahms');
    expect(a.documentTitle).not.toMatch(/evt_|occ_|19:30/);
  });

  it('conserva el título base de eventos únicos, incluso con aliases', () => {
    const catalog = makeCatalog({ events: [makeEvent({ slugAliases: ['titulo-anterior'] })] });
    expect(buildEventPageModel(catalog, 'matinees-de-otono', testClock)?.documentTitle)
      .toBe('Matinées de otoño · Auditorio Nacional de Música');
    const venueInTitle = makeEvent({ title: 'Concierto en Auditorio Nacional de Música' });
    expect(buildEventPageModel(makeCatalog({ events: [venueInTitle] }), venueInTitle.slug, testClock)?.documentTitle)
      .toBe(venueInTitle.title);
  });

  it('toma la representación próxima, o la última del archivo, sin fusionar funciones', () => {
    const event = repeatedEvent('evt_a', '2026-10-28');
    event.occurrences.unshift({ id: 'occ_past', date: '2026-07-01', time: '20:00', status: 'scheduled' });
    const catalog = makeCatalog({ events: [event, repeatedEvent('evt_b', '2026-10-29')] });
    const future = buildEventPageModel(catalog, event.slug, testClock)!;
    const historical = buildEventPageModel(catalog, event.slug, { now: () => new Date('2027-01-01T12:00:00Z') })!;
    expect(future.documentTitle).toContain('28 oct 2026');
    expect(historical.documentTitle).toContain('28 oct 2026');
    expect(historical.description).toContain('28 de octubre de 2026');
    const entities = future.jsonLd.filter((item) => item['@type'] === 'MusicEvent');
    expect(entities).toHaveLength(2);
    expect(new Set(entities.map((item) => item['@id'])).size).toBe(2);
    expect(entities.every((item) => item.name === event.title)).toBe(true);
  });

  it('London Philharmonic 28/29 de octubre conserva dos fichas con repertorios distintos', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const events = catalog.events.filter((event) => event.title === 'Ibermúsica. London Philharmonic Orchestra')
      .sort((a, b) => a.occurrences[0]!.date.localeCompare(b.occurrences[0]!.date));
    expect(events).toHaveLength(2);
    const [a, b] = events.map((event) => buildEventPageModel(catalog, event.slug, testClock)!);
    expect(a!.documentTitle).toContain('28 oct 2026');
    expect(b!.documentTitle).toContain('29 oct 2026');
    expect(a!.documentTitle).not.toBe(b!.documentTitle);
    expect(a!.title).toBe(events[0]!.title);
    expect(b!.title).toBe(events[1]!.title);
    expect(a!.description).toContain('Daniel Müller-Schott');
    expect(a!.description).toContain('Jean Sibelius');
    expect(b!.description).toContain('Piotr Ilich Chaikovski');
    expect(b!.description).not.toMatch(/Daniel Müller-Schott|Sibelius/);
    for (const page of [a!, b!]) {
      expect(page.description).toContain('Edward Gardner');
      expect(page.description).toContain('Julia Fischer');
      expect(page.description.length).toBeLessThanOrEqual(EVENT_DESCRIPTION_MAX_LENGTH);
      const entities = page.jsonLd.filter((item) => item['@type'] === 'MusicEvent');
      expect(entities).toHaveLength(1);
      expect(entities[0]!.name).toBe(page.title);
      expect(entities[0]).not.toHaveProperty('offers');
    }
  });

  it('alinea la metadata histórica con la función destacada cuando hay horas desconocidas', () => {
    const event = repeatedEvent('evt_a', '2026-07-01', null);
    event.occurrences.push({ id: 'occ_known', date: '2026-07-01', time: '20:00', status: 'scheduled' });
    const page = buildEventPageModel(makeCatalog({ events: [event, repeatedEvent('evt_b', '2026-07-01', '18:00')] }), event.slug, testClock)!;
    expect(page.featuredOccurrence?.time).toBe('20:00');
    expect(page.documentTitle).toContain('1 jul 2026 · 20:00');
    expect(page.description).toContain('1 de julio de 2026 a las 20:00');
  });

  it('el catálogo publicado elimina títulos idénticos cuando sus datos permiten distinguirlos', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const events = listCanonicalEvents(catalog);
    const titles = buildEventDocumentTitles(events, testClock.now());
    for (const event of events) {
      const peers = events.filter((other) => other.event.id !== event.event.id
        && eventDocumentTitle(other.event.title, other.rootVenue.name) === eventDocumentTitle(event.event.title, event.rootVenue.name));
      for (const peer of peers) {
        const facts = (item: typeof event) => JSON.stringify([
          item.event.occurrences.map(({ date, time }) => [date, time]), item.spaceName,
          item.event.composers, item.event.works, item.event.performers, item.series?.name,
        ]);
        if (facts(event) !== facts(peer)) expect(titles.get(event.event.id)).not.toBe(titles.get(peer.event.id));
      }
    }
  });
});

describe('descriptions desde datos canónicos', () => {
  it('incluye músicos, compositores, obra, ciclo y acceso cuando caben', () => {
    const event = makeEvent({ title: 'Recital', performers: [{ name: 'Ana Ruiz' }], composers: [{ name: 'Bach' }],
      works: [{ title: 'Preludio', composerName: 'Bach' }], access: 'free', formats: ['organ'] });
    const description = buildEventPageModel(makeCatalog({ events: [event] }), event.slug, testClock)!.description;
    expect(description).toContain('Ana Ruiz. Bach. Programa: Preludio (Bach).');
    expect(description).toContain('Ciclo: Ciclo de Cámara');
    expect(description).toContain('Entrada gratuita');
    expect(description).toContain('Órgano');
  });

  it('limita listados abundantes y campos largos sin inventar músicos ni repertorio', () => {
    const event = makeEvent({ performers: Array.from({ length: 40 }, (_, i) => ({ name: `Intérprete ${i}` })),
      composers: Array.from({ length: 40 }, (_, i) => ({ name: `Compositor ${i}` })),
      works: Array.from({ length: 40 }, (_, i) => ({ title: `Obra ${i}` })) });
    const model = buildEventPageModel(makeCatalog({ events: [event] }), event.slug, testClock)!;
    expect(model.description).toContain('Intérprete 0');
    expect(model.description).toContain('Compositor 0');
    expect(model.description).not.toMatch(/Intérprete 3|Compositor 3|Obra 1/);
    expect(model.description.length).toBeLessThanOrEqual(EVENT_DESCRIPTION_MAX_LENGTH);
    const long = buildEventPageModel(makeCatalog({ venues: [makeVenue({ name: 'Lugar '.repeat(50) })],
      events: [{ ...event, title: 'Título '.repeat(50) }] }), event.slug, testClock)!;
    expect(long.description.length).toBeLessThanOrEqual(EVENT_DESCRIPTION_MAX_LENGTH);
    expect(long.performers).toHaveLength(40);
  });

  it('mantiene fichas sin datos musicales y no inventa el acceso desconocido', () => {
    const event = makeEvent({ title: 'Concierto', performers: [], composers: [], works: [], formats: [], access: 'unknown', seriesId: null });
    const page = buildEventPageModel(makeCatalog({ events: [event] }), event.slug, testClock)!;
    expect(page.description).toBe('Concierto en Auditorio Nacional de Música, 15 de septiembre de 2026 a las 19:30.');
    expect(page.performers).toEqual([]);
    expect(page.jsonLd[0]).not.toHaveProperty('performer');
  });

  it('conserva obras sin compositores ni intérpretes', () => {
    const event = makeEvent({ performers: [], composers: [], works: [{ title: 'Preludio' }], seriesId: null });
    expect(buildEventPageModel(makeCatalog({ events: [event] }), event.slug, testClock)!.description).toContain('Programa: Preludio');
  });
});

describe('otros próximos conciertos del lugar', () => {
  it('excluye el evento actual y repeticiones, limita a tres y ordena por próxima función', () => {
    const catalog = richCatalog();
    catalog.events.push(repeatedEvent('evt_extra', '2026-09-16'), repeatedEvent('evt_ultimo', '2026-09-17'));
    const page = buildEventPageModel(catalog, 'concierto-de-verano', testClock)!;
    expect(page.isPast).toBe(true);
    expect(page.relatedConcerts.map((item) => item.eventSlug)).toEqual(['carmen', 'matinees-de-otono', 'evt_extra']);
    expect(page.relatedConcerts[0]!.date).toBe('2026-09-10');
    expect(buildEventPageModel(catalog, 'carmen', testClock)!.relatedConcerts.map((item) => item.eventSlug))
      .toEqual(['matinees-de-otono', 'evt_extra', 'evt_ultimo']);
  });

  it('incluye padre y salas hermanas, excluye otros lugares y estados no próximos', () => {
    const catalog = makeCatalog({ venues: [makeVenue(), room('ven_a', 'Sala A'), room('ven_b', 'Sala B'),
      makeVenue({ id: 'ven_other', slug: 'otro', name: 'Otro lugar' })],
      events: [
        { ...repeatedEvent('evt_current', '2026-10-28'), venueId: 'ven_a' },
        { ...repeatedEvent('evt_sibling', '2026-10-29'), venueId: 'ven_b' },
        repeatedEvent('evt_parent', '2026-10-30'),
        { ...repeatedEvent('evt_other', '2026-10-29'), venueId: 'ven_other' },
        { ...repeatedEvent('evt_cancelled', '2026-10-29'), status: 'cancelled' },
        { ...repeatedEvent('evt_postponed', '2026-10-29'), status: 'postponed' },
        repeatedEvent('evt_past', '2026-07-01'),
        { ...repeatedEvent('evt_cancelled_occ', '2026-10-29'), occurrences: [{ id: 'occ_cancelled', date: '2026-10-29', time: '19:30', status: 'cancelled' }] },
      ] });
    const page = buildEventPageModel(catalog, 'evt_current', testClock)!;
    expect(page.venueName).toBe(makeVenue().name);
    expect(page.spaceName).toBe('Sala A');
    expect(page.relatedConcerts.map((item) => item.eventSlug)).toEqual(['evt_sibling', 'evt_parent']);
    expect(page.relatedConcerts.every((item) => item.venueName === makeVenue().name)).toBe(true);
  });

  it('no presenta un bloque vacío cuando solo está el evento actual', () => {
    expect(buildEventPageModel(makeCatalog(), 'matinees-de-otono', testClock)!.relatedConcerts).toEqual([]);
    expect(buildEventPageModel(richCatalog(), 'recital-de-organo', testClock)!.relatedConcerts).toEqual([]);
  });
});
