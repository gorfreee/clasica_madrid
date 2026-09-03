import { describe, expect, it } from 'vitest';
import { classify, resolveKind } from '../src/ingestion/classification/classify.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { isPublishableInclude } from '../src/ingestion/classification/types.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { kindLabels } from '../src/lib/presentation/labels.ts';
import { matchVenue } from '../src/ingestion/venues.ts';

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return {
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function kindOf(venueText: string, extra: Partial<ObservedFacts> = {}) {
  return resolveKind(facts({ title: 'Concierto', venueText, ...extra }));
}

describe('kind — circuito del venue, no calidad', () => {
  it('Teatro Real → established', () => {
    expect(kindOf('Teatro Real').value).toBe('established');
  });

  it('Teatro de la Zarzuela → established', () => {
    expect(kindOf('Teatro de la Zarzuela').value).toBe('established');
  });

  it('Auditorio Nacional Sala Sinfónica → established', () => {
    expect(kindOf('Auditorio Nacional Sala Sinfónica').value).toBe('established');
    expect(kindOf('Sala Sinfónica').value).toBe('established');
  });

  it('Auditorio Nacional Sala de Cámara → established', () => {
    expect(kindOf('Auditorio Nacional Sala de Cámara').value).toBe('established');
    expect(kindOf('Sala de Cámara').value).toBe('established');
  });

  it('Teatro Monumental / Orquesta y Coro RTVE → established', () => {
    const result = kindOf('Teatro Monumental', {
      organizerText: 'Orquesta y Coro RTVE',
    });
    expect(result.value).toBe('established');
    expect(result.evidence.join(' ')).toMatch(/monumental/i);
  });

  it('Teatros del Canal, incluida Sala Roja Concha Velasco → established', () => {
    expect(kindOf('Teatros del Canal — Sala Roja Concha Velasco').value).toBe('established');
    expect(kindOf('Teatros del Canal Sala Verde').value).toBe('established');

    const match = matchVenue(
      { venueText: 'Sala Roja Concha Velasco', sourceId: 'teatros-canal' },
      emptyCatalog(),
    );
    expect(match?.venue.id).toBe('ven_teatros_canal_sala_roja');
    expect(
      resolveKind(facts({ title: 'Espectáculo', venueText: 'Sala Roja Concha Velasco' }), {
        id: match!.venue.id,
        name: match!.venue.name,
      }).value,
    ).toBe('established');
  });

  it('Fundación Juan March → established', () => {
    expect(kindOf('Fundación Juan March Auditorio').value).toBe('established');
  });

  it('iglesia, parroquia o basílica → alternative', () => {
    expect(kindOf('Iglesia de San Ginés').value).toBe('alternative');
    expect(kindOf('Parroquia de Santa María').value).toBe('alternative');
    expect(kindOf('Basílica Pontificia de San Miguel').value).toBe('alternative');
  });

  it('colegio → alternative', () => {
    expect(kindOf('Colegio San Agustín').value).toBe('alternative');
  });

  it('centro cívico / espacio municipal no concertístico → alternative', () => {
    expect(kindOf('Centro Cívico de Usera').value).toBe('alternative');
    expect(kindOf('Centro Cultural Casa de Vacas (Retiro)').value).toBe('alternative');
  });

  it('parque u otro espacio abierto no concertístico → alternative', () => {
    expect(kindOf('Parque Lineal de Palomeras').value).toBe('alternative');
    expect(kindOf('Puente de Toledo').value).toBe('alternative');
  });

  it('una orquesta internacional en una iglesia sigue siendo alternative', () => {
    const result = resolveKind(
      facts({
        title: 'Berliner Philharmoniker',
        venueText: 'Iglesia de San Antonio de los Alemanes',
        performers: [{ name: 'Berliner Philharmoniker', roleText: 'orquesta' }],
        organizerText: 'CNDM',
        seriesText: 'Universo Barroco',
      }),
    );
    expect(result.value).toBe('alternative');
  });

  it('todo include termina con kind established o alternative', () => {
    const result = classify(
      facts({
        title: 'Partita n.º 2',
        venueText: 'Local municipal de Usera',
        composers: [{ name: 'Johann Sebastian Bach' }],
        works: [{ title: 'Partita n.º 2', composerName: 'Johann Sebastian Bach' }],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.kind).toBeDefined();
    expect(['established', 'alternative']).toContain(result.kind?.value);
    expect(result.kind?.value).toBe('alternative');
    expect(isPublishableInclude(result)).toBe(true);
  });

  it('un venue habitual no convierte por sí solo un evento en include', () => {
    const result = classify(
      facts({
        title: 'Quinteto en el Auditorio',
        categoryText: 'Jazz en el Auditorio',
        venueText: 'Teatro Real',
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.kind).toBeUndefined();
  });

  it('la IA no puede cambiar un kind ya resuelto desde el venue', async () => {
    const observed = facts({
      title: 'Concierto de órgano',
      venueText: 'Basílica Pontificia de San Miguel',
      seriesText: 'Ciclo Internacional de Órgano',
      categoryText: 'Ciclo Internacional de Órgano; Conciertos',
    });
    const deterministic = classify(observed);
    expect(deterministic.eligibility.value).toBe('include');
    expect(deterministic.kind?.value).toBe('alternative');

    const result = await classifyObserved(observed, {
      ai: {
        async classify() {
          return { eligibility: 'include', kind: 'established', formats: ['organ'], eras: [] };
        },
      },
    });
    expect(result.kind?.value).toBe('alternative');
    expect(result.kind?.method).not.toBe('ai');
  });

  it('el label visible de established es Circuito habitual', () => {
    expect(kindLabels.established).toBe('Circuito habitual');
    expect(kindLabels.alternative).toBe('Alternativo');
  });
});
