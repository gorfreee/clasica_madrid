import { describe, expect, it } from 'vitest';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { findScheduleCollisions } from '../src/lib/validation/schedule-collisions.ts';

const cndm = getSourceDefinition('cndm');

const ABSORBED_CNDM: Array<{ externalId: string; eventId: string }> = [
  { externalId: '23773', eventId: 'evt_auditorio_nacional_cndm_joven_orquesta_nacional_de_espana_jonde_1' },
  { externalId: '23774', eventId: 'evt_auditorio_nacional_cndm_joven_orquesta_nacional_de_espana_jonde_2' },
  { externalId: '23822', eventId: 'evt_auditorio_nacional_cndm_orquestra_de_la_comunitat_valenciana' },
  { externalId: '23802', eventId: 'evt_auditorio_nacional_cndm_les_accents_2' },
  { externalId: '23772', eventId: 'evt_auditorio_nacional_cndm_la_grande_chapelle_5' },
  { externalId: '23900', eventId: 'evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1' },
  { externalId: '23867', eventId: 'evt_auditorio_nacional_cndm_9' },
  { externalId: '23775', eventId: 'evt_auditorio_nacional_cndm_klangforum_wien_1' },
  { externalId: '23803', eventId: 'evt_auditorio_nacional_cndm_il_fervore' },
  { externalId: '23838', eventId: 'evt_auditorio_nacional_cndm_orquestra_de_la_comunitat_valenciana_1' },
  { externalId: '23827', eventId: 'evt_auditorio_nacional_cndm_cantoria_1' },
  { externalId: '23768', eventId: 'evt_auditorio_nacional_cndm_l2019arpeggiata_1' },
  { externalId: '23804', eventId: 'evt_auditorio_nacional_cndm_collegium_vocale_1704_collegium_1704' },
  { externalId: '23821', eventId: 'evt_auditorio_nacional_cndm_5' },
  { externalId: '23806', eventId: 'evt_auditorio_nacional_cndm_il_giardino_armonico_5' },
  { externalId: '23830', eventId: 'evt_auditorio_nacional_cndm_harmonia_del_parnas' },
  { externalId: '23808', eventId: 'evt_auditorio_nacional_cndm_vespres_d2019arnadi_6' },
  { externalId: '23812', eventId: 'evt_auditorio_nacional_cndm_10' },
  { externalId: '23813', eventId: 'evt_auditorio_nacional_cndm_le_concert_de_la_loge' },
  { externalId: '23770', eventId: 'evt_auditorio_nacional_cndm_neopercusion' },
  { externalId: '23834', eventId: 'evt_auditorio_nacional_cndm_orquesta_barroca_de_la_universidad_de_salamanca_2' },
];

describe('catálogo publicado tras la limpieza de duplicados de hueco exclusivo', () => {
  it('no retiene duplicados inequívocos y absorbe las citations CNDM', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const collisions = findScheduleCollisions(catalog);
    expect(collisions.filter((item) => item.kind === 'duplicate')).toEqual([]);
    expect(catalog.events.some((event) => event.id === 'evt_cndm_23900')).toBe(false);

    const oratorio = catalog.events.find(
      (event) => event.id === 'evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1',
    );
    expect(oratorio).toBeTruthy();
    expect(oratorio?.slug).toBe('cndm-la-filarmonica-oratorio-de-navidad');
    expect(oratorio?.citations.map((item) => item.sourceId)).toEqual([
      'src_auditorio_nacional',
      'src_cndm',
    ]);
    expect(oratorio?.citations.find((item) => item.sourceId === 'src_cndm')).toMatchObject({
      url: 'https://cndm.inaem.gob.es/node/23900',
      externalId: '23900',
    });

    const ids = new Set(catalog.events.map((event) => event.id));
    for (const { externalId, eventId } of ABSORBED_CNDM) {
      expect(ids.has(`evt_cndm_${externalId}`), `evt_cndm_${externalId} should be gone`).toBe(false);
      const event = catalog.events.find((item) => item.id === eventId);
      expect(event, eventId).toBeTruthy();
      expect(
        event?.citations.some(
          (citation) => citation.sourceId === 'src_cndm' && citation.externalId === externalId,
        ),
        `${eventId} should keep CNDM ${externalId}`,
      ).toBe(true);
    }

    const ospital = collisions.find((item) => item.eventIds.includes('evt_auditorio_nacional_cndm_thomas_ospital'));
    expect(ospital?.kind).toBe('conflict');
    expect(ospital?.eventIds).toEqual(
      expect.arrayContaining(['evt_auditorio_nacional_cndm_thomas_ospital', 'evt_cndm_23846']),
    );
  });

  it('reconoce la siguiente observación CNDM 23900 sobre el evento canónico', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://cndm.inaem.gob.es/node/23900',
      externalId: '23900',
      title: 'Collegium Vocale Gent & P. Herreweghe: "Oratorio de Navidad" (J. S. Bach)',
      occurrences: [{ date: '2026-12-17', time: '19:30' }],
      composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
      works: [{
        title: 'Oratorio de Navidad , BWV 248 (1734)',
        composerName: 'Johann Sebastian Bach (1685-1750)',
      }],
    }, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_auditorio_nacional_la_filarmonica_oratorio_de_navidad_1' },
    });
  });
});
