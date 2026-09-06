import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import type { Event } from '../src/lib/schemas/index.ts';

const auditorio = getSourceDefinition('auditorio-nacional');
const cndm = getSourceDefinition('cndm');

/** Identities confirmed against the Auditorio FullCalendar JSON via the current adapter. */
const REPAIRED_AUDITORIO_CNDM: ReadonlyArray<{
  eventId: string;
  url: string;
  externalId: string;
  cndmExternalId: string;
}> = [
  { eventId: 'evt_auditorio_nacional_23769', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-leticia-moreno-orquesta-de-camara-simon-bolivar', externalId: 'cndm-leticia-moreno-orquesta-de-camara-simon-bolivar', cndmExternalId: '23769' },
  { eventId: 'evt_auditorio_nacional_23771', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-vikingur-olafsson-4', externalId: 'cndm-vikingur-olafsson-4', cndmExternalId: '23771' },
  { eventId: 'evt_auditorio_nacional_23776', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-cosmos-2', externalId: 'cndm-cuarteto-cosmos-2', cndmExternalId: '23776' },
  { eventId: 'evt_auditorio_nacional_23778', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-de-jerusalen-3', externalId: 'cndm-cuarteto-de-jerusalen-3', cndmExternalId: '23778' },
  { eventId: 'evt_auditorio_nacional_23779', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-leonkoro', externalId: 'cndm-cuarteto-leonkoro', cndmExternalId: '23779' },
  { eventId: 'evt_auditorio_nacional_23780', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-ebene', externalId: 'cndm-cuarteto-ebene', cndmExternalId: '23780' },
  { eventId: 'evt_auditorio_nacional_23781', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-schumann', externalId: 'cndm-cuarteto-schumann', cndmExternalId: '23781' },
  { eventId: 'evt_auditorio_nacional_23782', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-quiroga-1', externalId: 'cndm-cuarteto-quiroga-1', cndmExternalId: '23782' },
  { eventId: 'evt_auditorio_nacional_23816', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-leticia-moreno-edicson-ruiz-gonzalo-grau', externalId: 'cndm-leticia-moreno-edicson-ruiz-gonzalo-grau', cndmExternalId: '23816' },
  { eventId: 'evt_auditorio_nacional_23817', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-fazil-say', externalId: 'cndm-fazil-say', cndmExternalId: '23817' },
  { eventId: 'evt_auditorio_nacional_23819', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-fazil-say-1', externalId: 'cndm-fazil-say-1', cndmExternalId: '23819' },
  { eventId: 'evt_auditorio_nacional_23825', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-delirivm-musica', externalId: 'cndm-delirivm-musica', cndmExternalId: '23825' },
  { eventId: 'evt_auditorio_nacional_23826', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-obni', externalId: 'cndm-obni', cndmExternalId: '23826' },
  { eventId: 'evt_auditorio_nacional_23828', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-hippocampus-1', externalId: 'cndm-hippocampus-1', cndmExternalId: '23828' },
  { eventId: 'evt_auditorio_nacional_23829', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-collegium-vocale-gent-1', externalId: 'cndm-collegium-vocale-gent-1', cndmExternalId: '23829' },
  { eventId: 'evt_auditorio_nacional_23832', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-vox-luminis-4', externalId: 'cndm-vox-luminis-4', cndmExternalId: '23832' },
  { eventId: 'evt_auditorio_nacional_23833', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-capella-de-ministrers-2', externalId: 'cndm-capella-de-ministrers-2', cndmExternalId: '23833' },
  { eventId: 'evt_auditorio_nacional_23836', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-irene-roldan', externalId: 'cndm-irene-roldan', cndmExternalId: '23836' },
  { eventId: 'evt_auditorio_nacional_23837', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-benjamin-alard-8', externalId: 'cndm-benjamin-alard-8', cndmExternalId: '23837' },
  { eventId: 'evt_auditorio_nacional_23839', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-benjamin-alard-9', externalId: 'cndm-benjamin-alard-9', cndmExternalId: '23839' },
  { eventId: 'evt_auditorio_nacional_23840', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-celine-frisch', externalId: 'cndm-celine-frisch', cndmExternalId: '23840' },
  { eventId: 'evt_auditorio_nacional_23841', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-diego-ares', externalId: 'cndm-diego-ares', cndmExternalId: '23841' },
  { eventId: 'evt_auditorio_nacional_23842', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-orquestra-de-la-comunitat-valenciana-2', externalId: 'cndm-orquestra-de-la-comunitat-valenciana-2', cndmExternalId: '23842' },
  { eventId: 'evt_auditorio_nacional_23845', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-juan-de-la-rubia-1', externalId: 'cndm-juan-de-la-rubia-1', cndmExternalId: '23845' },
  { eventId: 'evt_auditorio_nacional_23848', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-daniel-oyarzabal-suhar-korua', externalId: 'cndm-daniel-oyarzabal-suhar-korua', cndmExternalId: '23848' },
  { eventId: 'evt_auditorio_nacional_23849', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-benjamin-alard-7', externalId: 'cndm-benjamin-alard-7', cndmExternalId: '23849' },
  { eventId: 'evt_auditorio_nacional_23868', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-tabea-zimmermann-jean-guihen-queyras-javier-perianes', externalId: 'cndm-tabea-zimmermann-jean-guihen-queyras-javier-perianes', cndmExternalId: '23868' },
  { eventId: 'evt_auditorio_nacional_23869', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-trio-arbos', externalId: 'cndm-trio-arbos', cndmExternalId: '23869' },
  { eventId: 'evt_auditorio_nacional_23870', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-cuarteto-gringolts-clemens-hagen', externalId: 'cndm-cuarteto-gringolts-clemens-hagen', cndmExternalId: '23870' },
  { eventId: 'evt_auditorio_nacional_23871', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-ana-maria-valderrama-judith-jauregui', externalId: 'cndm-ana-maria-valderrama-judith-jauregui', cndmExternalId: '23871' },
  { eventId: 'evt_auditorio_nacional_24018', url: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-barbara-hannigan-bertrand-chamayou', externalId: '3458720415294d028ad8af92e3777416', cndmExternalId: '24018' },
];

const REPAIRED_AUDITORIO_ORCAM: ReadonlyArray<{
  eventId: string;
  url: string;
  externalId: string;
  orcamExternalId: string;
}> = [
  { eventId: 'evt_auditorio_nacional_4848', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-5-evocacion', externalId: 'orcam-sinfonico-5-evocacion', orcamExternalId: '4848' },
  { eventId: 'evt_auditorio_nacional_4851', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-6-memoria-de-un-mundo', externalId: 'orcam-sinfonico-6-memoria-de-un-mundo', orcamExternalId: '4851' },
  { eventId: 'evt_auditorio_nacional_4853', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-7-pasion-y-extasis', externalId: 'orcam-sinfonico-7-pasion-y-extasis', orcamExternalId: '4853' },
  { eventId: 'evt_auditorio_nacional_4855', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-8-duelo-de-sombras', externalId: 'orcam-sinfonico-8-duelo-de-sombras', orcamExternalId: '4855' },
  { eventId: 'evt_auditorio_nacional_4857', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-9-arquitecturas-del-espiritu', externalId: 'orcam-sinfonico-9-arquitecturas-del-espiritu', orcamExternalId: '4857' },
  { eventId: 'evt_auditorio_nacional_4859', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-10-amores-imposibles', externalId: 'orcam-sinfonico-10-amores-imposibles', orcamExternalId: '4859' },
  { eventId: 'evt_auditorio_nacional_4863', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-sinfonico-12-reina-roja', externalId: 'orcam-sinfonico-12-reina-roja', orcamExternalId: '4863' },
  { eventId: 'evt_auditorio_nacional_4870', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-tiempo-de-camara-1', externalId: 'orcam-tiempo-de-camara-1', orcamExternalId: '4870' },
  { eventId: 'evt_auditorio_nacional_4872', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-tiempo-de-camara-2', externalId: 'orcam-tiempo-de-camara-2', orcamExternalId: '4872' },
  { eventId: 'evt_auditorio_nacional_4874', url: 'https://auditorionacional.inaem.gob.es/es/programacion/orcam-tiempo-de-camara-5-las-tres-b', externalId: 'orcam-tiempo-de-camara-5-las-tres-b', orcamExternalId: '4874' },
];

const REPAIRED_CNDM_LIED: ReadonlyArray<{
  eventId: string;
  url: string;
  externalId: string;
  zarzuelaExternalId: string;
}> = [
  { eventId: 'evt_cndm_es_temporada_ciclo_de_lied_2026_2027_anja_mittermuller', url: 'https://cndm.inaem.gob.es/node/23795', externalId: '23795', zarzuelaExternalId: '/es/temporada/ciclo-de-lied-2026-2027/anja-mittermuller' },
  { eventId: 'evt_cndm_es_temporada_ciclo_de_lied_2026_2027_jose_antonio_lopez', url: 'https://cndm.inaem.gob.es/node/23798', externalId: '23798', zarzuelaExternalId: '/es/temporada/ciclo-de-lied-2026-2027/jose-antonio-lopez' },
  { eventId: 'evt_cndm_es_temporada_ciclo_de_lied_2026_2027_julia_kleiter', url: 'https://cndm.inaem.gob.es/node/23797', externalId: '23797', zarzuelaExternalId: '/es/temporada/ciclo-de-lied-2026-2027/julia-kleiter' },
  { eventId: 'evt_cndm_es_temporada_ciclo_de_lied_2026_2027_julian_pregardien', url: 'https://cndm.inaem.gob.es/node/23796', externalId: '23796', zarzuelaExternalId: '/es/temporada/ciclo-de-lied-2026-2027/julian-pregardien' },
];

function citationOf(event: Event, sourceId: string, url?: string) {
  return event.citations.find((citation) =>
    citation.sourceId === sourceId && (!url || citation.url === url),
  );
}

function requireEvent(catalog: { events: Event[] }, eventId: string): Event {
  const event = catalog.events.find((item) => item.id === eventId);
  expect(event, eventId).toBeTruthy();
  return event!;
}

describe('provenance source-aware de citations publicadas', () => {
  it('conserva las identities confirmadas de Auditorio, CNDM y ORCAM tras la reparación', async () => {
    const dataDir = defaultDataDir();
    const catalog = await loadCatalogFromDir(dataDir);

    for (const row of REPAIRED_AUDITORIO_CNDM) {
      const event = requireEvent(catalog, row.eventId);
      expect(event.slug).toBeTruthy();
      expect(event.primarySourceId).toBe(auditorio.catalogSourceId);
      expect(existsSync(path.join(dataDir, 'events', `${event.id}.json`))).toBe(true);
      expect(citationOf(event, auditorio.catalogSourceId)).toMatchObject({
        sourceId: auditorio.catalogSourceId,
        url: row.url,
        externalId: row.externalId,
      });
      expect(citationOf(event, auditorio.catalogSourceId)?.externalId).not.toBe(row.cndmExternalId);
      expect(
        event.citations.some(
          (citation) => citation.sourceId === cndm.catalogSourceId && citation.externalId === row.cndmExternalId,
        ),
        `${row.eventId} should keep CNDM ${row.cndmExternalId}`,
      ).toBe(true);
    }

    for (const row of REPAIRED_AUDITORIO_ORCAM) {
      const event = requireEvent(catalog, row.eventId);
      expect(event.primarySourceId).toBe(auditorio.catalogSourceId);
      expect(existsSync(path.join(dataDir, 'events', `${event.id}.json`))).toBe(true);
      expect(citationOf(event, auditorio.catalogSourceId)).toMatchObject({
        sourceId: auditorio.catalogSourceId,
        url: row.url,
        externalId: row.externalId,
      });
      expect(citationOf(event, auditorio.catalogSourceId)?.externalId).not.toBe(row.orcamExternalId);
      expect(
        event.citations.some(
          (citation) => citation.sourceId === 'src_fundacion_orcam' && citation.externalId === row.orcamExternalId,
        ),
        `${row.eventId} should keep ORCAM ${row.orcamExternalId}`,
      ).toBe(true);
    }

    for (const row of REPAIRED_CNDM_LIED) {
      const event = requireEvent(catalog, row.eventId);
      expect(event.primarySourceId).toBe(cndm.catalogSourceId);
      expect(existsSync(path.join(dataDir, 'events', `${event.id}.json`))).toBe(true);
      expect(citationOf(event, cndm.catalogSourceId, row.url)).toMatchObject({
        sourceId: cndm.catalogSourceId,
        url: row.url,
        externalId: row.externalId,
      });
      expect(citationOf(event, 'src_teatro_zarzuela')).toMatchObject({
        sourceId: 'src_teatro_zarzuela',
        externalId: row.zarzuelaExternalId,
      });
    }
  });

  it('no toca eventos absorbidos que ya tenían identities distintas por source', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const creacion = requireEvent(catalog, 'evt_auditorio_nacional_orcam_sinfonico_1_la_creacion_de_un_todo');
    expect(citationOf(creacion, auditorio.catalogSourceId)).toMatchObject({
      externalId: 'orcam-sinfonico-1-la-creacion-de-un-todo',
    });
    expect(citationOf(creacion, 'src_fundacion_orcam')).toMatchObject({ externalId: '4840' });

    const louvre = requireEvent(catalog, 'evt_auditorio_nacional_cndm_les_musiciens_du_louvre_1');
    expect(citationOf(louvre, auditorio.catalogSourceId)).toMatchObject({
      externalId: 'cndm-les-musiciens-du-louvre-1',
    });
    expect(citationOf(louvre, cndm.catalogSourceId)).toMatchObject({ externalId: '23799' });

    const schager = requireEvent(catalog, 'evt_teatro_zarzuela_es_temporada_ciclo_de_lied_2026_2027_andreas_schager');
    expect(citationOf(schager, 'src_teatro_zarzuela')).toMatchObject({
      externalId: '/es/temporada/ciclo-de-lied-2026-2027/andreas-schager',
    });
    expect(citationOf(schager, cndm.catalogSourceId)).toMatchObject({ externalId: '23792' });
  });

  it('reconoce una observación futura de Auditorio por externalId aunque cambie la fecha', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const published = requireEvent(catalog, 'evt_auditorio_nacional_23769');
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-leticia-moreno-orquesta-de-camara-simon-bolivar',
      externalId: 'cndm-leticia-moreno-orquesta-de-camara-simon-bolivar',
      title: 'CNDM. Leticia Moreno & Orquesta de Cámara Simón Bolívar',
      occurrences: [{ date: '2028-01-15', time: '21:00' }],
    }, {
      catalogSourceId: auditorio.catalogSourceId,
      venueId: published.venueId,
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: published.id, slug: published.slug },
    });
  });

  it('reconoce el FullCalendar id de Hannigan aunque la fecha observada cambie', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const published = requireEvent(catalog, 'evt_auditorio_nacional_24018');
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://auditorionacional.inaem.gob.es/es/programacion/cndm-barbara-hannigan-bertrand-chamayou',
      externalId: '3458720415294d028ad8af92e3777416',
      title: 'CNDM. Barbara Hannigan & Bertrand Chamayou',
      occurrences: [{ date: '2028-02-01', time: '19:30' }],
    }, {
      catalogSourceId: auditorio.catalogSourceId,
      venueId: published.venueId,
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_auditorio_nacional_24018' },
    });
  });
});
