import { describe, expect, it } from 'vitest';
import {
  canonicalizeComposerList,
  canonicalizeComposerName,
  canonicalizeWorkList,
} from '../src/ingestion/composer-name.ts';
import { parseCndmDetail } from '../src/ingestion/detail/cndm.ts';
import { canonicalizeArtificiallyUppercase } from '../src/ingestion/event-title.ts';
import { mergeExistingEvent, proposalFromObservation } from '../src/ingestion/merge.ts';
import { looksLikeComposerLine } from '../src/ingestion/observed-cleanup.ts';
import { stripTrailingBiographicalYears } from '../src/ingestion/knowledge/composers.ts';
import { toCandidate } from '../src/ingestion/to-candidate.ts';
import type { NormalizedEvent } from '../src/ingestion/normalize.ts';
import type { PublishableClassification } from '../src/ingestion/classification/types.ts';
import { getSourceDefinition } from '../src/ingestion/registry.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeEvent, makeSource, makeVenue, TEST_NOW } from './helpers.ts';
import type { RawEvent } from '../src/ingestion/types.ts';

function includeClassification(): PublishableClassification {
  return {
    eligibility: { value: 'include', method: 'rule', ruleId: 'test-include', evidence: [] },
    formats: { value: ['recital'], method: 'rule', ruleId: 'formats-test', evidence: [] },
    eras: { value: ['baroque'], method: 'knowledge', ruleId: 'eras-test', evidence: [] },
    kind: { value: 'established', method: 'knowledge', ruleId: 'established-circuit', evidence: [] },
    access: { value: 'paid', method: 'rule', ruleId: 'access-paid', evidence: [] },
  };
}

function teatroCatalog() {
  const catalog = emptyCatalog();
  catalog.venues.push(
    makeVenue({
      id: 'ven_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      address: 'Plaza de Isabel II, s/n, 28013 Madrid',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  catalog.sources.push(
    makeSource({
      id: 'src_teatro_real',
      slug: 'teatro-real',
      name: 'Teatro Real',
      url: 'https://www.teatroreal.es/es',
    }),
  );
  return catalog;
}

function observed(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'teatro-real',
    sourceUrl: 'https://www.teatroreal.es/es/espectaculo/demo',
    externalId: 'demo',
    title: 'Demo',
    occurrences: [{ date: '2026-09-10', time: '19:30' }],
    venueText: 'Teatro Real',
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function publish(event: Partial<NormalizedEvent> = {}) {
  return toCandidate(
    observed(event),
    getSourceDefinition('teatro-real'),
    teatroCatalog(),
    TEST_NOW,
    new Set(),
    new Set(),
    includeClassification(),
  ).candidate?.event;
}

describe('canonicalizeComposerName', () => {
  it.each([
    ['Bach', 'Johann Sebastian Bach'],
    ['J. S. Bach', 'Johann Sebastian Bach'],
    ['J.S. Bach', 'Johann Sebastian Bach'],
    ['Johann Sebastian Bach (1685-1750)', 'Johann Sebastian Bach'],
    ['  Johann Sebastian Bach   (1685–1750)  ', 'Johann Sebastian Bach'],
  ])('converge %s a Johann Sebastian Bach', (input, expected) => {
    expect(canonicalizeComposerName(input)).toBe(expected);
  });

  it.each(['Beethoven', 'L. van Beethoven', 'L. v. Beethoven', 'L. Beethoven', 'Ludwig van Beethoven'])(
    'converge %s a Ludwig van Beethoven',
    (input) => {
      expect(canonicalizeComposerName(input)).toBe('Ludwig van Beethoven');
    },
  );

  it('quita una anotación de año de nacimiento abierto', () => {
    expect(canonicalizeComposerName('Philip Glass (1937)')).toBe('Philip Glass');
  });

  it('quita un arco vital con guion ASCII', () => {
    expect(canonicalizeComposerName('Krzysztof Penderecki (1933-2020)')).toBe('Krzysztof Penderecki');
  });

  it('usa el canonicalName de COMPOSERS ante transliteración y diacríticos', () => {
    expect(canonicalizeComposerName('Sergei Rachmaninoff')).toBe('Serguéi Rajmáninov');
    expect(canonicalizeComposerName('Pyotr Ilyich Tchaikovsky')).toBe('Piotr Ilich Chaikovski');
    expect(canonicalizeComposerName('Antonin Dvorak')).toBe('Antonín Dvořák');
  });

  it('conserva un nombre desconocido con casing mixto razonable', () => {
    expect(canonicalizeComposerName('Marina Vespertilio')).toBe('Marina Vespertilio');
  });

  it('un alias ALL CAPS conocido usa canonicalName, no sólo title-case', () => {
    expect(canonicalizeComposerName('BACH')).toBe('Johann Sebastian Bach');
    expect(canonicalizeComposerName('FRANCISCO ASENJO BARBIERI')).toBe('Francisco Asenjo Barbieri');
    expect(canonicalizeArtificiallyUppercase('BACH')).toBe('Bach');
  });

  it('aplica sólo la canonicalización ALL CAPS existente a un desconocido', () => {
    expect(canonicalizeComposerName('JAVIER MARTÍNEZ CAMPOS')).toBe(
      canonicalizeArtificiallyUppercase('JAVIER MARTÍNEZ CAMPOS'),
    );
    expect(canonicalizeComposerName('JAVIER MARTÍNEZ CAMPOS')).toBe('Javier Martínez Campos');
  });

  it('no elimina paréntesis que no son una anotación biográfica de años', () => {
    expect(canonicalizeComposerName('Marina Vespertilio (edición crítica)')).toBe(
      'Marina Vespertilio (edición crítica)',
    );
    expect(canonicalizeComposerName('Marina Vespertilio (s. XVII)')).toBe('Marina Vespertilio (s. XVII)');
    expect(canonicalizeComposerName('Marina Vespertilio (arr. 2010)')).toBe(
      'Marina Vespertilio (arr. 2010)',
    );
    expect(stripTrailingBiographicalYears('Marina Vespertilio (Homenaje a Falla)')).toBe(
      'Marina Vespertilio (Homenaje a Falla)',
    );
  });

  it('omite atribuciones que no son una persona-compositor', () => {
    expect(canonicalizeComposerName('Varios autores')).toBeUndefined();
    expect(canonicalizeComposerName('VARIOS AUTORES')).toBeUndefined();
    expect(canonicalizeComposerName('Anónimo (s. XVII)')).toBeUndefined();
    expect(canonicalizeComposerName('Tradicional de Venezuela')).toBeUndefined();
    expect(canonicalizeComposerName('Traditional')).toBeUndefined();
  });

  it('acepta anotaciones ca. y las quita del nombre publicado', () => {
    expect(canonicalizeComposerName('Johann Pachelbel (ca. 1653-1706)')).toBe('Johann Pachelbel');
  });
});

describe('listas publicadas', () => {
  it('deduplica aliases de la misma persona conservando el primer orden', () => {
    expect(
      canonicalizeComposerList([
        { name: 'Bach' },
        { name: 'Mozart' },
        { name: 'J. S. Bach' },
        { name: 'Johann Sebastian Bach (1685-1750)' },
      ]),
    ).toEqual([{ name: 'Johann Sebastian Bach' }, { name: 'Wolfgang Amadeus Mozart' }]);
  });

  it('omite composerName de una obra si no es una persona', () => {
    expect(
      canonicalizeWorkList([
        { title: 'Danza', composerName: 'Tradicional de Venezuela' },
        { title: 'Preludio', composerName: 'Bach' },
        { title: 'Canción', composerName: 'Anónimo (s. XVII)' },
      ]),
    ).toEqual([
      { title: 'Danza' },
      { title: 'Preludio', composerName: 'Johann Sebastian Bach' },
      { title: 'Canción' },
    ]);
  });
});

describe('NormalizedEvent → Event publicado', () => {
  it('publica la identidad canónica y deduplica aliases en composers[] y works[]', () => {
    const event = publish({
      composers: [
        { name: 'Bach' },
        { name: 'J. S. Bach' },
        { name: 'Varios autores' },
        { name: 'Anónimo (s. XVII)' },
        { name: 'Tradicional de Venezuela' },
        { name: 'Marina Vespertilio' },
        { name: 'JAVIER MARTÍNEZ CAMPOS' },
      ],
      works: [
        { title: 'El clave bien temperado', composerName: 'Johann Sebastian Bach (1685-1750)' },
        { title: 'Danza', composerName: 'Tradicional de Venezuela' },
        { title: 'Canción anónima', composerName: 'Anónimo (s. XVII)' },
        { title: 'Estudio', composerName: 'Marina Vespertilio (edición crítica)' },
      ],
    });

    expect(event?.id).toBe('evt_teatro_real_demo');
    expect(event?.slug).toBe('demo');
    expect(event?.composers).toEqual([
      { name: 'Johann Sebastian Bach' },
      { name: 'Marina Vespertilio' },
      { name: 'Javier Martínez Campos' },
    ]);
    expect(event?.works).toEqual([
      { title: 'El clave bien temperado', composerName: 'Johann Sebastian Bach' },
      { title: 'Danza' },
      { title: 'Canción anónima' },
      { title: 'Estudio', composerName: 'Marina Vespertilio (edición crítica)' },
    ]);
  });

  it('las fechas siguen señalando un encabezado de compositor y desaparecen del Event', () => {
    const heading = 'Johann Sebastian Bach (1685-1750)';
    expect(looksLikeComposerLine(heading)).toBe(true);
    expect(looksLikeComposerLine('Tradicional de Venezuela')).toBe(false);

    const html = `<head><link rel="canonical" href="https://cndm.inaem.gob.es/node/23837"></head>
<div class="event-banner"><div class="event-banner__title"><a href="/node/23837">BENJAMIN ALARD</a></div>
<div class="event-banner__dates">19:30<br>Octubre/26<br><strong>Vie16</strong></div>
<div class="event-banner__detail"><p>Benjamin Alard, clave</p><p class="pt-3">Auditorio Nacional (Cámara) | Madrid</p></div></div>
<div class="event-place"><h3>Auditorio Nacional (Cámara) | Madrid</h3></div>
<div class="event-program"><h3>Programa</h3><p><strong>Johann Sebastian Bach (1685-1750)</strong><br>El clave bien temperado, libro I (1722)</p></div>
<div class="content"><p>Benjamin Alard interpreta el Libro I.</p></div>
<div class="tickets"><a>Entradas</a></div>`;
    const raw: RawEvent = {
      sourceId: 'cndm',
      sourceUrl: 'https://cndm.inaem.gob.es/node/23837',
      externalId: '23837',
      observed: {
        title: 'BENJAMIN ALARD',
        venueText: 'Auditorio Nacional (Cámara) | Madrid',
        occurrences: [{ raw: '2026-10-16 19:30', date: '2026-10-16', time: '19:30' }],
        performers: [],
        composers: [],
        works: [],
      },
    };
    const patch = parseCndmDetail(raw, html);
    expect(patch.composers).toEqual([{ name: heading }]);
    expect(patch.works).toEqual([
      { title: 'El clave bien temperado, libro I (1722)', composerName: heading },
    ]);

    const event = publish({
      composers: patch.composers,
      works: patch.works,
    });
    expect(event?.composers).toEqual([{ name: 'Johann Sebastian Bach' }]);
    expect(event?.works).toEqual([
      { title: 'El clave bien temperado, libro I (1722)', composerName: 'Johann Sebastian Bach' },
    ]);
  });

  it('proposalFromObservation aplica la misma frontera de publicación', () => {
    const proposal = proposalFromObservation(
      observed({
        composers: [{ name: 'Beethoven' }, { name: 'L. van Beethoven' }, { name: 'Varios autores' }],
        works: [{ title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven (1770-1827)' }],
      }),
      { catalogSourceId: 'src_teatro_real', now: TEST_NOW, venueId: 'ven_teatro_real' },
    );
    expect(proposal.composers).toEqual([{ name: 'Ludwig van Beethoven' }]);
    expect(proposal.works).toEqual([
      { title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven' },
    ]);
  });

  it('merge no duplica un alias ya publicado y corrige el spelling canónico', () => {
    const existing = makeEvent({
      composers: [{ name: 'Bach' }],
      works: [{ title: 'Preludio', composerName: 'J. S. Bach' }],
    });
    const merged = mergeExistingEvent(
      existing,
      proposalFromObservation(
        observed({
          title: existing.title,
          composers: [{ name: 'Johann Sebastian Bach (1685-1750)' }],
          works: [{ title: 'Preludio', composerName: 'Bach' }],
        }),
        { catalogSourceId: 'src_auditorio', now: TEST_NOW, venueId: existing.venueId },
      ),
      TEST_NOW,
    );
    expect(merged.event.composers).toEqual([{ name: 'Johann Sebastian Bach' }]);
    expect(merged.event.works).toEqual([{ title: 'Preludio', composerName: 'Johann Sebastian Bach' }]);
    expect(merged.event.id).toBe(existing.id);
    expect(merged.event.slug).toBe(existing.slug);
  });
});
