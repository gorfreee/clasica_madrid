import { describe, expect, it } from 'vitest';
import { matchEventIdentity } from '../src/ingestion/identity.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';
import { findScheduleCollisionIssues, findScheduleCollisions } from '../src/lib/validation/schedule-collisions.ts';

const cndm = getSourceDefinition('cndm');
const madridDatos = getSourceDefinition('madrid-datos');
const piuMosso = getSourceDefinition('fundacion-piu-mosso');

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
  { externalId: '23846', eventId: 'evt_auditorio_nacional_cndm_lucie_zakova' },
];

describe('catálogo publicado tras la limpieza de duplicados de hueco exclusivo', () => {
  it('no retiene duplicados inequívocos y absorbe las citations CNDM', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const collisions = findScheduleCollisions(catalog);
    expect(collisions.filter((item) => item.kind === 'duplicate')).toEqual([]);
    expect(collisions.filter((item) => item.kind === 'review')).toEqual([]);
    const issues = findScheduleCollisionIssues(catalog);
    expect(issues.filter((issue) => issue.code === 'schedule-conflict').every((issue) => issue.severity === 'warning')).toBe(true);
    expect(issues.filter((issue) => issue.code === 'schedule-review')).toEqual([]);
    expect(catalog.events.some((event) => event.id === 'evt_madrid_datos_50221891')).toBe(false);
    expect(catalog.events.some((event) => event.id === 'evt_fundacion_piu_mosso_2187')).toBe(false);
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
    expect(ospital).toBeUndefined();
    expect(catalog.events.some((event) => event.id === 'evt_cndm_23846')).toBe(false);
    const zakova = catalog.events.find(
      (event) => event.id === 'evt_auditorio_nacional_cndm_lucie_zakova',
    );
    expect(zakova?.slug).toBe('cndm-lucie-zakova');
    expect(zakova?.slugAliases).toEqual(['lucie-zakova']);
    expect(zakova?.occurrences[0]).toMatchObject({ date: '2027-02-20', time: '12:00' });

    const tempo = catalog.events.find((event) => event.id === 'evt_madrid_tempo_clausura_20260906');
    expect(tempo).toBeTruthy();
    expect(tempo?.slug).toBe('madrid-a-tempo-concierto-clausura');
    expect(tempo?.slugAliases).toEqual(['ii-festival-internacional-de-piano']);
    expect(tempo?.title).toBe('Madrid a Tempo: Concierto de clausura de alumnos');
    expect(tempo?.organizerIds).toEqual(['org_madrid_a_tempo']);
    expect(tempo?.seriesId).toBe('ser_festival_madrid_a_tempo_2026');
    expect(tempo?.occurrences[0]).toMatchObject({ date: '2026-09-06', time: '12:00' });
    expect(tempo?.citations.map((item) => item.sourceId)).toEqual([
      'src_madrid_a_tempo',
      'src_ayuntamiento_madrid',
    ]);
    expect(tempo?.citations.find((item) => item.sourceId === 'src_ayuntamiento_madrid')).toMatchObject({
      url: 'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=5e05cff3cf74c910VgnVCM100000891ecb1aRCRD',
      checkedAt: '2026-09-03',
      externalId: '50221891',
    });
    expect(tempo?.citations.find((item) => item.sourceId === 'src_madrid_a_tempo')).toMatchObject({
      url: 'https://www.madridatempo.com/programacion-2023',
      checkedAt: '2026-08-28',
    });

    const larrocha = catalog.events.find((event) => event.id === 'evt_madrid_datos_50265531');
    expect(larrocha).toBeTruthy();
    expect(larrocha?.slug).toBe('iv-edicion-festival-alicia-de-larrocha');
    expect(larrocha?.slugAliases).toEqual(['victor-tretyakov-piano']);
    expect(larrocha?.title).toBe('IV Edición Festival Alicia de Larrocha');
    expect(larrocha?.performers).toEqual([{ name: 'Victor Tretyakov' }]);
    expect(larrocha?.composers.map((item) => item.name)).toEqual([
      'Robert Schumann',
      'Frédéric Chopin',
      'Johannes Brahms',
      'Ludwig van Beethoven',
      'Maurice Ravel',
      'Franz Liszt',
    ]);
    expect(larrocha?.composers.some((item) => /moszkowski/i.test(item.name))).toBe(false);
    expect(larrocha?.occurrences[0]).toMatchObject({ date: '2026-09-12', time: '19:30' });
    expect(larrocha?.citations.map((item) => item.sourceId)).toEqual([
      'src_ayuntamiento_madrid',
      'src_fundacionpiumosso_com',
    ]);
    expect(larrocha?.citations.find((item) => item.sourceId === 'src_fundacionpiumosso_com')).toMatchObject({
      url: 'https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano',
      checkedAt: '2026-09-06',
      externalId: '2187',
    });
    expect(larrocha?.citations.find((item) => item.sourceId === 'src_ayuntamiento_madrid')).toMatchObject({
      url: 'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=a8d5e042bd42d910VgnVCM200000f921e388RCRD',
      checkedAt: '2026-09-06',
      externalId: '50265531',
    });

    const casaVacas = collisions.filter((item) => item.venueId === 'ven_casa_vacas_retiro');
    expect(casaVacas).toEqual([]);

    const kavakosOrcam = collisions.find((item) =>
      item.eventIds.includes('evt_auditorio_nacional_fundacion_scherzo_leonidas_kavakos_y_enrico_pace')
      && item.eventIds.includes('evt_fundacion_orcam_4861'),
    );
    expect(kavakosOrcam?.kind).toBe('conflict');
    expect(kavakosOrcam).toMatchObject({ date: '2027-05-11', time: '19:30' });

    const excelentiaOrcam = collisions.find((item) =>
      item.eventIds.includes('evt_auditorio_nacional_excelentia_strauss_don_juan_y_sinfonia_5_beethoven')
      && item.eventIds.includes('evt_fundacion_orcam_4865'),
    );
    expect(excelentiaOrcam?.kind).toBe('conflict');
    expect(excelentiaOrcam).toMatchObject({ date: '2027-06-01', time: '19:30' });
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

  it('reconoce la siguiente observación CNDM 23846 sobre Lucie Žáková canónica', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://cndm.inaem.gob.es/node/23846',
      externalId: '23846',
      title: 'Lucie Žáková',
      occurrences: [{ date: '2027-02-20', time: '12:00' }],
      performers: [{ name: 'Lucie Žáková' }],
      composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
      works: [{
        title: 'Preludio y fuga en la menor, BWV 543 (d. 1715)',
        composerName: 'Johann Sebastian Bach (1685-1750)',
      }],
    }, {
      catalogSourceId: cndm.catalogSourceId,
      venueId: 'ven_auditorio_nacional_sala_sinfonica',
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_auditorio_nacional_cndm_lucie_zakova' },
    });
  });

  it('reconoce la siguiente observación municipal 50221891 sobre la clausura de Madrid a Tempo', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://www.madrid.es/sites/v/index.jsp?vgnextchannel=ca9671ee4a9eb410VgnVCM100000171f5a0aRCRD&vgnextoid=5e05cff3cf74c910VgnVCM100000891ecb1aRCRD',
      externalId: '50221891',
      title: 'II Festival Internacional de Piano',
      occurrences: [{ date: '2026-09-06', time: '12:00' }],
      performers: [],
      composers: [],
      works: [],
    }, {
      catalogSourceId: madridDatos.catalogSourceId,
      venueId: 'ven_casa_vacas_retiro',
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_madrid_tempo_clausura_20260906' },
    });
  });

  it('reconoce la siguiente observación Più Mosso 2187 sobre el Festival Alicia de Larrocha', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const match = matchEventIdentity(catalog, {
      sourceUrl: 'https://www.fundacionpiumosso.com/evento/victor-tretyakov-piano',
      externalId: '2187',
      title: 'VICTOR TRETYAKOV, Piano',
      occurrences: [{ date: '2026-09-12', time: '19:30' }],
      performers: [],
      composers: [
        { name: 'Robert Schumann' },
        { name: 'Frédéric Chopin' },
        { name: 'Johannes Brahms' },
        { name: 'Ludwig van Beethoven' },
        { name: 'Maurice Ravel' },
        { name: 'Franz Liszt' },
      ],
      works: [],
    }, {
      catalogSourceId: piuMosso.catalogSourceId,
      venueId: 'ven_casa_vacas_retiro',
    });
    expect(match).toMatchObject({
      kind: 'matched',
      method: 'externalId',
      event: { id: 'evt_madrid_datos_50265531' },
    });
  });
});
