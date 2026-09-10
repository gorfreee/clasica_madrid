import { describe, expect, it } from 'vitest';
import { enrichNormalizedEvent } from '../src/ingestion/enrich-normalized.ts';
import { normalizeRawEvent } from '../src/ingestion/normalize.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import { emptyObservedLists } from '../src/ingestion/observed.ts';
import { loadCatalogFromDir } from '../src/lib/repository/load.ts';
import { defaultDataDir } from '../src/lib/repository/fs.ts';

const SISYPHUS_PROGRAM = 'Obras de J. S. Bach, F. Couperin, H. I. F. von Biber y G. Ligeti';
const SISYPHUS_COMPOSERS = [
  { name: 'Johann Sebastian Bach' },
  { name: 'François Couperin' },
  { name: 'Heinrich Ignaz Franz Biber' },
  { name: 'György Ligeti' },
];

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'cndm',
    sourceUrl: 'https://cndm.inaem.gob.es/node/23815',
    title: 'CNDM. Jean Rondeau',
    occurrences: [{ date: '2026-12-19', time: '22:30' }],
    performers: [{ name: 'JEAN RONDEAU' }],
    composers: [],
    works: [],
    ...overrides,
  };
}

describe('enriquecimiento determinista de compositores conocidos', () => {
  it('rellena composers canónicos desde programText CNDM sin inventar obras', () => {
    const enriched = enrichNormalizedEvent(event({ programText: SISYPHUS_PROGRAM }));
    expect(enriched.composers).toEqual(SISYPHUS_COMPOSERS);
    expect(enriched.works).toEqual([]);
    expect(enriched.performers).toEqual([{ name: 'JEAN RONDEAU' }]);
  });

  it('conserva la grafía estructurada y no la sustituye por el canónico del knowledge', () => {
    const structured = [
      { name: 'Louis Couperin (1626-1661)' },
      { name: 'Jean-Philippe Rameau (1683-1764)' },
    ];
    const works = [
      { title: 'Suite en la menor, de Pièces de clavecin', composerName: 'Louis Couperin (1626-1661)' },
    ];
    const enriched = enrichNormalizedEvent(
      event({
        composers: structured,
        works,
        programText: 'Louis Couperin (1626-1661) — Suite. J. S. Bach — Variaciones Goldberg',
      }),
    );
    expect(enriched.composers).toEqual([
      { name: 'Louis Couperin (1626-1661)' },
      { name: 'Johann Sebastian Bach' },
      { name: 'Jean-Philippe Rameau (1683-1764)' },
    ]);
    expect(enriched.works).toEqual(works);
  });

  it('usa composers explícitos de works[] y completa otros inequívocos del programa', () => {
    const works = [{ title: 'Suite en la menor', composerName: 'Louis Couperin (1626-1661)' }];
    const enriched = enrichNormalizedEvent(
      event({
        composers: [],
        works,
        programText: 'Louis Couperin (1626-1661) — Suite. György Ligeti — Continuum',
      }),
    );
    expect(enriched.composers).toEqual([
      { name: 'Louis Couperin (1626-1661)' },
      { name: 'György Ligeti' },
    ]);
    expect(enriched.works).toEqual(works);
  });

  it('completa composers estructurados con otros inequívocos del programText, sin duplicar', () => {
    const enriched = enrichNormalizedEvent(
      event({
        title: 'Divina Proportione: un viaje por la riqueza sonora del Renacimiento',
        composers: [{ name: 'Juan del Encina' }, { name: 'Francisco Guerrero' }],
        programText:
          'Obras de Josquin des Prez, Juan del Encina, Francisco Guerrero y Antonio de Cabezón.',
      }),
    );
    expect(enriched.composers.map((item) => item.name)).toEqual([
      'Josquin des Prez',
      'Juan del Encina',
      'Francisco Guerrero',
      'Antonio de Cabezón',
    ]);
  });

  it('no añade un intérprete aunque su nombre aparezca en el programText y exista en el knowledge', () => {
    const enriched = enrichNormalizedEvent(
      event({
        composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Wolfgang Amadeus Mozart' }],
        performers: [{ name: 'Clara Schumann', roleText: 'piano' }],
        programText: 'Obras de Beethoven y Schubert. Piano: Clara Schumann',
      }),
    );
    expect(enriched.composers.map((item) => item.name)).toEqual([
      'Ludwig van Beethoven',
      'Franz Schubert',
      'Johann Sebastian Bach',
      'Wolfgang Amadeus Mozart',
    ]);
  });

  it('conserva un compositor estructurado aunque también figure como intérprete', () => {
    const enriched = enrichNormalizedEvent(
      event({
        composers: [{ name: 'Clara Schumann' }],
        performers: [{ name: 'Clara Schumann', roleText: 'piano' }],
        programText: 'Clara Schumann — Notturno, op. 6 n.º 2. Robert Schumann — Carnaval, op. 9',
      }),
    );
    expect(enriched.composers.map((item) => item.name)).toEqual([
      'Clara Schumann',
      'Robert Schumann',
    ]);
  });

  it('no completa composers estructurados desde el título si no hay programText', () => {
    const enriched = enrichNormalizedEvent(
      event({
        title: SISYPHUS_PROGRAM,
        composers: [{ name: 'Juan del Encina' }],
        programText: undefined,
      }),
    );
    expect(enriched.composers).toEqual([{ name: 'Juan del Encina' }]);
  });

  it('puede usar el título como fallback inequívoco si no hay programText', () => {
    const enriched = enrichNormalizedEvent(
      event({
        title: SISYPHUS_PROGRAM,
        programText: undefined,
      }),
    );
    expect(enriched.composers).toEqual(SISYPHUS_COMPOSERS);
  });

  it('no usa la description editorial para poblar composers[]', () => {
    const enriched = enrichNormalizedEvent(
      event({
        title: 'Sisyphus',
        description: SISYPHUS_PROGRAM,
        programText: undefined,
      }),
    );
    expect(enriched.composers).toEqual([]);
  });

  it('no añade el pariente homónimo cuando el programText nombra a otro miembro de la familia', () => {
    expect(
      enrichNormalizedEvent(
        event({
          title: 'Recital de clave',
          programText: [
            'Johann Christian Bach (1735-1782)',
            'Sinfonía en sol menor, op. 6 n.º 6',
            'Concierto para clave en mi bemol mayor, op. 7 n.º 5',
          ].join('\n'),
        }),
      ).composers,
    ).toEqual([{ name: 'Johann Christian Bach' }]);

    expect(
      enrichNormalizedEvent(
        event({
          title: 'Recital de piano',
          programText: 'Clara Schumann — Notturno, op. 6 n.º 2',
        }),
      ).composers,
    ).toEqual([{ name: 'Clara Schumann' }]);

    expect(
      enrichNormalizedEvent(
        event({
          title: 'Recital de piano',
          programText: [
            'Clara Schumann — Notturno, op. 6 n.º 2',
            'Robert Schumann — Carnaval, op. 9',
          ].join('\n'),
        }),
      ).composers.map((item) => item.name),
    ).toEqual(['Clara Schumann', 'Robert Schumann']);

    expect(
      enrichNormalizedEvent(event({ title: 'Recital', programText: 'Bach: Suite n.º 1' })).composers,
    ).toEqual([{ name: 'Johann Sebastian Bach' }]);
  });

  it('no infiere compositores de menciones contextuales ya protegidas', () => {
    for (const programText of [
      'Un homenaje a Rameau en clave contemporánea',
      'Pieza basada en Mozart e inspirada en Bach',
      'Variaciones para orquesta sobre un tema de Rameau (2001)',
      'CIM ANTONIO SOLER. COLEGIO JESÚS MAESTRO.',
    ]) {
      expect(enrichNormalizedEvent(event({ title: 'Recital', programText })).composers, programText).toEqual(
        [],
      );
      expect(enrichNormalizedEvent(event({ title: programText, programText: undefined })).composers, programText).toEqual(
        [],
      );
    }
  });

  it('deduplica por identidad canónica', () => {
    const enriched = enrichNormalizedEvent(
      event({
        composers: [{ name: 'J. S. Bach' }, { name: 'Johann Sebastian Bach' }],
        works: [{ title: 'Suite', composerName: 'Bach' }],
      }),
    );
    expect(enriched.composers).toEqual([{ name: 'J. S. Bach' }]);
  });

  it('el fallback ocurre sobre el NormalizedEvent, antes de clasificar o publicar', () => {
    const normalized = normalizeRawEvent({
      sourceId: 'cndm',
      sourceUrl: 'https://cndm.inaem.gob.es/node/23815',
      observed: {
        title: 'CNDM. Jean Rondeau',
        occurrences: [{ raw: '2026-12-19T22:30:00+01:00' }],
        programText: SISYPHUS_PROGRAM,
        ...emptyObservedLists(),
        performers: [{ name: 'JEAN RONDEAU' }],
      },
    });
    expect(normalized?.composers).toEqual([]);
    expect(enrichNormalizedEvent(normalized!).composers).toEqual(SISYPHUS_COMPOSERS);
  });
});

describe('catálogo publicado: Jean Rondeau 18 vs 19', () => {
  it('el concierto Sisyphus publica los cuatro compositores CNDM y sigue sin obras', async () => {
    const catalog = await loadCatalogFromDir(defaultDataDir());
    const sisyphus = catalog.events.find((item) => item.id === 'evt_auditorio_nacional_cndm_jean_rondeau');
    const structured = catalog.events.find((item) => item.id === 'evt_auditorio_nacional_cndm_jean_rondeau_1');
    expect(sisyphus?.performers).toEqual([{ name: 'Jean Rondeau' }]);
    expect(sisyphus?.composers).toEqual(SISYPHUS_COMPOSERS);
    expect(sisyphus?.works).toEqual([]);
    expect(structured?.performers).toEqual([{ name: 'Jean Rondeau' }]);
    expect(structured?.composers).toEqual([
      { name: 'Louis Couperin' },
      { name: 'Jean-Philippe Rameau' },
      { name: 'François Couperin' },
      { name: 'Joseph-Nicolas-Pancrace Royer' },
    ]);
    expect(structured?.works.length).toBeGreaterThan(0);
  });
});
