import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import { findPossiblyMissing } from '../src/ingestion/disappear.ts';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { runIngest } from '../src/ingestion/pipeline.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { TEST_NOW, makeEvent, makeSource, makeVenue } from './helpers.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures', 'ingestion');
const PORTAL_URL =
  'https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Ciudad-Lineal/Retransmision-del-Pleno-en-directo/Actuacion-musica-Musica-clasica/?vgnextchannel=cd0a32e941f22610VgnVCM1000008a4a900aRCRD&vgnextfmt=default&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD';
const LISTING_URL =
  'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=aab47760175ff910VgnVCM100000891ecb1aRCRD';
const MISSING_URL =
  'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=deadbeefdeadbeefVgnVCM100000891ecb1aRCRD';

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clasica-madrid-datos-'));
  for (const collection of ENTITY_COLLECTIONS) {
    await mkdir(path.join(dir, collection), { recursive: true });
  }
  return dir;
}

function madridCatalog() {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_parque_lineal_palomeras',
      slug: 'parque-lineal-de-palomeras',
      name: 'Parque Lineal de Palomeras',
      address: 'Avenida de la Albufera, 293, 28031 Madrid',
      url: 'https://www.madrid.es/',
    }),
    makeVenue({
      id: 'ven_casa_vacas_retiro',
      slug: 'casa-de-vacas-retiro',
      name: 'Centro Cultural Casa de Vacas',
    }),
    makeVenue({
      id: 'ven_auditorio_nacional',
      slug: 'auditorio-nacional',
      name: 'Auditorio Nacional de Música',
    }),
  );
  catalog.sources.push(
    makeSource({
      id: 'src_ayuntamiento_madrid',
      slug: 'ayuntamiento-de-madrid',
      name: 'Ayuntamiento de Madrid',
      url: 'https://www.madrid.es/',
    }),
    makeSource({
      id: 'src_auditorio_nacional',
      slug: 'auditorio-nacional',
      name: 'Auditorio Nacional',
      url: 'https://auditorionacional.inaem.gob.es/',
    }),
  );
  catalog.events.push(
    makeEvent({
      id: 'evt_sonidos_universo_20260927',
      slug: 'los-sonidos-del-universo',
      title: 'Los sonidos del universo',
      venueId: 'ven_parque_lineal_palomeras',
      organizerIds: [],
      seriesId: null,
      occurrences: [
        { id: 'occ_sonidos_universo_20260927_01', date: '2026-09-27', time: '21:00', status: 'scheduled' },
      ],
      performers: [],
      composers: [],
      works: [],
      eras: [],
      formats: ['other'],
      kind: 'alternative',
      access: 'free',
      citations: [{ sourceId: 'src_ayuntamiento_madrid', url: PORTAL_URL, checkedAt: '2026-08-28' }],
      primarySourceId: 'src_ayuntamiento_madrid',
      lastVerifiedAt: '2026-08-28',
    }),
    makeEvent({
      id: 'evt_madrid_datos_ausente',
      slug: 'recital-ausente',
      title: 'Recital ausente',
      venueId: 'ven_casa_vacas_retiro',
      organizerIds: [],
      seriesId: null,
      occurrences: [
        { id: 'occ_madrid_datos_ausente_01', date: '2026-09-20', time: '19:00', status: 'scheduled' },
      ],
      performers: [],
      composers: [],
      works: [],
      eras: [],
      formats: ['recital'],
      kind: 'alternative',
      access: 'free',
      citations: [{ sourceId: 'src_ayuntamiento_madrid', url: MISSING_URL, checkedAt: '2026-08-28', externalId: '50999999' }],
      primarySourceId: 'src_ayuntamiento_madrid',
      lastVerifiedAt: '2026-08-28',
    }),
    makeEvent({
      id: 'evt_ocne_existente',
      slug: 'ocne-existente',
      title: 'OCNE. Existente',
      venueId: 'ven_auditorio_nacional',
      organizerIds: [],
      seriesId: null,
      occurrences: [
        { id: 'occ_ocne_existente_01', date: '2026-09-18', time: '19:30', status: 'scheduled' },
      ],
      citations: [
        {
          sourceId: 'src_auditorio_nacional',
          url: 'https://auditorionacional.inaem.gob.es/es/programacion/ocne-existente',
          checkedAt: '2026-08-20',
        },
      ],
      primarySourceId: 'src_auditorio_nacional',
      lastVerifiedAt: '2026-08-20',
    }),
  );
  return catalog;
}

async function runMadridDatos(listing: string) {
  return runIngest({
    dataDir: await tempDataDir(),
    catalog: madridCatalog(),
    now: TEST_NOW,
    dryRun: true,
    sourceIds: ['madrid-datos'],
    get: async (url: string) => {
      if (url.includes('agenda-eventos-culturales-100') || url.includes('agenda.json')) return listing;
      return '<article><h1>Los sonidos del universo</h1><p>Concierto de música clásica.</p></article>';
    },
  });
}

describe('madrid-datos: actuación música fuera del kos Musica', () => {
  it('reconoce la ficha portal por vgnextoid aunque el título del listing sea la categoría', () => {
    const catalog = madridCatalog();
    const match = matchEventIdentity(
      catalog,
      {
        sourceUrl: LISTING_URL,
        externalId: '50379624',
        title: 'Actuación música. Música clásica',
        occurrences: [{ date: '2026-09-27', time: '21:00' }],
      },
      { catalogSourceId: 'src_ayuntamiento_madrid', venueId: 'ven_parque_lineal_palomeras' },
    );
    expect(match).toMatchObject({ kind: 'matched', method: 'url', event: { id: 'evt_sonidos_universo_20260927' } });
  });

  it('el concierto real deja de ser possiblyMissing y uno ausente sigue siéndolo', async () => {
    const listing = await readFile(path.join(fixtures, 'madrid-agenda-sonidos-universo.json'), 'utf8');
    const run = await runMadridDatos(listing);
    expect(run.rawEvents.some((event) => event.externalId === '50379624')).toBe(true);
    expect(run.possiblyMissing.map((item) => item.eventId)).toEqual(['evt_madrid_datos_ausente']);
    expect(run.possiblyMissing.some((item) => item.eventId === 'evt_sonidos_universo_20260927')).toBe(false);
    expect(run.possiblyMissing.some((item) => item.eventId === 'evt_ocne_existente')).toBe(false);
    const seen = run.decisions.find((item) => item.identity?.eventId === 'evt_sonidos_universo_20260927');
    expect(seen?.identity?.method).toBe('url');
    expect(seen?.externalId).toBe('50379624');
  });

  it('un feed de música sin ese concierto sí marca possiblyMissing', async () => {
    const listing = JSON.stringify({
      '@graph': [
        {
          '@type': 'https://datos.madrid.es/egob/kos/actividades/Musica',
          id: '50376447',
          title: 'Concierto de música renacentista',
          dtstart: '2026-09-19 19:00:00.0',
          time: '19:00',
          link: 'http://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=3da1e3ca4e0df910VgnVCM200000f921e388RCRD',
          'event-location': 'Centro Cultural Casa de Vacas (Retiro)',
        },
      ],
    });
    const run = await runMadridDatos(listing);
    expect(run.rawEvents).toHaveLength(1);
    expect(run.possiblyMissing.map((item) => item.eventId).sort()).toEqual([
      'evt_madrid_datos_ausente',
      'evt_sonidos_universo_20260927',
    ]);
  });

  it('el resto de sources sigue evaluando desapariciones por su propia cobertura', () => {
    const catalog = madridCatalog();
    const madrid = getSourceDefinition('madrid-datos');
    const auditorio = getSourceDefinition('auditorio-nacional');
    const missing = findPossiblyMissing({
      catalog,
      now: TEST_NOW,
      sources: [madrid, auditorio],
      succeededSourceIds: ['madrid-datos', 'auditorio-nacional'],
      failedSourceIds: [],
      seenEventIds: new Set(['evt_sonidos_universo_20260927']),
    });
    expect(missing.map((item) => item.eventId).sort()).toEqual(['evt_madrid_datos_ausente', 'evt_ocne_existente']);
  });
});
