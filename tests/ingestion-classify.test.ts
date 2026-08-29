import { describe, expect, it } from 'vitest';
import { classify, resolveAccess, resolveFormats, resolveKind } from '../src/ingestion/classification/classify.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return {
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

describe('eligibility — exclusiones de identidad', () => {
  it('excluye jazz como identidad principal, no por el venue', () => {
    const result = classify(
      facts({
        title: 'Quinteto en el Auditorio',
        categoryText: 'Jazz en el Auditorio',
        venueText: 'Auditorio Nacional',
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('jazz-identity');
  });

  it('excluye flamenco anunciado como gala, no un concierto que mencione Andalucía', () => {
    const result = classify(
      facts({
        title: 'Gala de jóvenes flamencos',
        categoryText: 'Andalucía Flamenca',
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
  });

  it('excluye danza como espectáculo, no una suite de ballet en un concierto', () => {
    const dance = classify(
      facts({
        title: 'El Cascanueces',
        categoryText: 'Danza',
        composers: [{ name: 'Chaikovski' }],
      }),
    );
    expect(dance.eligibility.value).toBe('exclude');
    expect(dance.eligibility.ruleId).toBe('dance-spectacle');

    const suite = classify(
      facts({
        title: 'Concierto sinfónico',
        programText: 'Chaikovski: Suite del ballet El Cascanueces',
        composers: [{ name: 'Chaikovski' }],
        performers: [{ name: 'Orquesta Nacional', roleText: 'orquesta' }],
      }),
    );
    expect(suite.eligibility.value).not.toBe('exclude');
    expect(suite.eligibility.value).toBe('include');
  });

  it('excluye cine cuando ver la película es la actividad principal', () => {
    const result = classify(
      facts({
        title: 'Cineclásica: El gabinete del doctor Caligari',
        categoryText: 'Cine mudo con música en vivo',
        description: 'Proyección de una de las películas más influyentes del cine mudo.',
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('cinema-projection');
  });

  it('excluye un taller aunque cite a Puccini', () => {
    const result = classify(
      facts({
        title: '¿Te suena Manon Lescaut, de G. Puccini?',
        categoryText: 'Taller musical en familia',
        description: 'Un taller de introducción a la música para todos los públicos.',
        composers: [{ name: 'G. Puccini' }],
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('non-performance-activity');
  });

  it('excluye pop anunciado como identidad, aunque haya orquesta', () => {
    const result = classify(
      facts({
        title: 'ABBA, Queen, Beatles y Otros Grandes del Pop',
        performers: [{ name: 'Pop Orchestra', roleText: 'orquesta' }],
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('popular-music-identity');
  });

  it('excluye DJ / crossover aunque cite a Vivaldi', () => {
    const result = classify(
      facts({
        title: 'DJ Délica. Las Cuatro Estaciones de Vivaldi',
        composers: [{ name: 'Antonio Vivaldi' }],
        works: [{ title: 'Las cuatro estaciones', composerName: 'Antonio Vivaldi' }],
        performers: [{ name: 'DJ Délica' }],
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('dj-identity');
  });

  it('excluye música de cine como identidad principal', () => {
    const result = classify(
      facts({
        title: 'Film Symphony Orchestra. Especial John Williams',
        composers: [{ name: 'John Williams' }],
        programText: 'Bandas sonoras de Star Wars e Indiana Jones',
        performers: [{ name: 'Film Symphony Orchestra', roleText: 'orquesta' }],
      }),
    );
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('film-music-identity');
  });
});

describe('eligibility — conflictos y fallback', () => {
  it('no convierte en include un compositor clásico conocido + identidad DJ', () => {
    const result = classify(
      facts({
        title: 'Vivaldi Night',
        composers: [{ name: 'Antonio Vivaldi' }],
        performers: [{ name: 'DJ Symphonic' }],
      }),
    );
    expect(result.eligibility.value).not.toBe('include');
    expect(result.eligibility.value).toBe('exclude');
  });

  it('deja uncertain un barroco coprincipal con flamenco', () => {
    const result = classify(
      facts({
        title: 'Sarao Barroco',
        description:
          'El pulso festivo del Barroco y el flamenco. Cante: Eva Durán. Guitarra flamenca: José Almarcha.',
        performers: [
          { name: 'Eva Durán', roleText: 'cante' },
          { name: 'José Almarcha', roleText: 'guitarra flamenca' },
        ],
      }),
    );
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('classical-and-nonclassical-coprincipal');
  });

  it('no incluye orquesta + repertorio pop', () => {
    const result = classify(
      facts({
        title: 'Sinfónico',
        performers: [{ name: 'Orquesta de Madrid', roleText: 'orquesta' }],
        programText: 'Queen – Bohemian rhapsody; Beatles – Let it be; ABBA – Mamma Mia',
      }),
    );
    expect(result.eligibility.value).not.toBe('include');
  });

  it('incluye un programa clásico conocido sin evidencia contradictoria', () => {
    const result = classify(
      facts({
        title: 'OCNE. Sinfónico 01',
        composers: [{ name: 'Gustav Mahler' }],
        works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
        performers: [{ name: 'Orquesta y Coro Nacionales de España' }],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.ruleId).toBe('known-classical-composer');
  });

  it('deja uncertain un concierto genérico sin programa ni compositores', () => {
    const result = classify(
      facts({
        title: 'Concierto de Navidad',
        categoryText: 'Conciertos',
        performers: [{ name: 'Orquesta Clásica Santa Cecilia', roleText: 'orquesta' }],
      }),
    );
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('insufficient-evidence');
  });
});

describe('eligibility — source y venue no determinan', () => {
  it('Teatro Real, Auditorio Nacional y CNDM no implican include', () => {
    for (const item of [
      facts({ title: 'Gala', venueText: 'Teatro Real' }),
      facts({ title: 'Gala', venueText: 'Auditorio Nacional de Música' }),
      facts({ title: 'CNDM. Encuentro', venueText: 'Sala de Cámara' }),
    ]) {
      expect(classify(item).eligibility.value).not.toBe('include');
    }
  });

  it('Madrid Datos, una iglesia o un espacio alternativo no implican exclude', () => {
    const church = classify(
      facts({
        title: 'Oratorio de Navidad',
        venueText: 'Iglesia de San Antonio de los Alemanes',
        composers: [{ name: 'J.S. Bach' }],
        works: [{ title: 'Oratorio de Navidad', composerName: 'J.S. Bach' }],
      }),
    );
    expect(church.eligibility.value).toBe('include');

    const municipal = classify(
      facts({
        title: 'Los sonidos del universo',
        categoryText: 'Actuación música / Música clásica',
        venueText: 'Parque Lineal de Palomeras',
      }),
    );
    expect(municipal.eligibility.value).not.toBe('exclude');
    expect(municipal.eligibility.value).toBe('uncertain');
  });
});

describe('short-circuit del classifier', () => {
  it('no calcula formats/eras/kind/access cuando eligibility no es include', () => {
    const excluded = classify(
      facts({
        title: 'Jazz en el Auditorio',
        categoryText: 'Jazz en el Auditorio',
        accessText: '20 €',
      }),
    );
    expect(excluded.eligibility.value).toBe('exclude');
    expect(excluded.formats).toBeUndefined();
    expect(excluded.eras).toBeUndefined();
    expect(excluded.kind).toBeUndefined();
    expect(excluded.access).toBeUndefined();

    const uncertain = classify(facts({ title: 'Concierto' }));
    expect(uncertain.eligibility.value).toBe('uncertain');
    expect(uncertain.formats).toBeUndefined();
  });

  it('sí resuelve kind para todo include', () => {
    const result = classify(
      facts({
        title: 'Recital',
        composers: [{ name: 'Johann Sebastian Bach' }],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.kind?.value).toBeDefined();
    expect(['established', 'alternative']).toContain(result.kind?.value);
  });
});

describe('formats', () => {
  it('asigna formats conservadores a denominaciones claras', () => {
    expect(
      resolveFormats(
        facts({
          title: 'OCNE',
          performers: [
            { name: 'Orquesta Nacional', roleText: 'orquesta' },
            { name: 'Coro Nacional', roleText: 'coro' },
          ],
        }),
      ).value.sort(),
    ).toEqual(['choral', 'symphonic']);

    expect(
      resolveFormats(
        facts({
          title: 'Cuarteto Casals',
          categoryText: 'Liceo de Cámara XXI',
          performers: [{ name: 'Cuarteto Casals', roleText: 'cuarteto' }],
        }),
      ).value,
    ).toEqual(['chamber']);

    expect(
      resolveFormats(
        facts({
          title: 'Recital de órgano',
          performers: [{ name: 'Cindy Castillo', roleText: 'órgano' }],
        }),
      ).value,
    ).toEqual(['recital', 'organ']);

    expect(
      resolveFormats(
        facts({
          title: 'Manon Lescaut',
          categoryText: 'Ópera',
          composers: [{ name: 'Giacomo Puccini' }],
        }),
      ).value,
    ).toEqual(['opera']);

    expect(
      resolveFormats(
        facts({
          title: 'La verbena de la Paloma',
          description: 'Zarzuela de Tomás Bretón',
        }),
      ).value,
    ).toEqual(['zarzuela']);
  });

  it('no fuerza un format ambiguo', () => {
    expect(resolveFormats(facts({ title: 'Concierto' })).value).toEqual([]);
  });
});

describe('kind', () => {
  it('usa entidades del evento, no el sourceId', () => {
    const established = resolveKind(
      facts({
        title: 'CNDM. Cuarteto Casals',
        venueText: 'Sala de Cámara',
      }),
    );
    expect(established.value).toBe('established');
    expect(established.ruleId).toBe('established-circuit');

    const fallback = resolveKind(
      facts({
        title: 'Open Piano',
        venueText: 'Puente de Toledo',
      }),
    );
    expect(fallback.value).toBe('alternative');
    expect(fallback.ruleId).toBe('kind-alternative-fallback');
  });

  it('no trata Real Teatro de Retiro como Teatro Real', () => {
    const result = resolveKind(
      facts({
        title: 'Miniclásica',
        venueText: 'HALL Real Teatro de Retiro',
      }),
    );
    expect(result.value).toBe('alternative');
  });
});

describe('access', () => {
  it('resuelve sólo desde accessText y no trata entradas gratuitas como paid', () => {
    expect(resolveAccess('entrada libre').value).toBe('free');
    expect(resolveAccess('gratuito').value).toBe('free');
    expect(resolveAccess('Entrada libre hasta completar aforo').value).toBe('free');
    expect(resolveAccess('entradas gratuitas').value).toBe('free');
    expect(resolveAccess('1').value).toBe('free');
    expect(resolveAccess('Compra tus entradas').value).toBe('paid');
    expect(resolveAccess('Desde 15 euros').value).toBe('paid');
    expect(resolveAccess('40, 36 y 28 €').value).toBe('paid');
    expect(resolveAccess('paid').value).toBe('paid');
    expect(resolveAccess(undefined).value).toBe('unknown');
    expect(resolveAccess('consultar').value).toBe('unknown');
    expect(resolveAccess('entradas').value).toBe('unknown');
  });
});
