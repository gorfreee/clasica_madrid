import { describe, expect, it } from 'vitest';
import { classify, resolveAccess, resolveEras, resolveFormats, resolveKind } from '../src/ingestion/classification/classify.ts';
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

  it('excluye flamenco musical real: zambomba, recital y Paco de Lucía', () => {
    expect(
      classify(facts({ title: 'CNDM. Zambomba Flamenca de Jerez' })).eligibility.value,
    ).toBe('exclude');
    expect(
      classify(facts({ title: 'Recital de flamenco', description: 'Cante y guitarra.' })).eligibility
        .value,
    ).toBe('exclude');
    expect(
      classify(
        facts({
          title: 'Excelentia. Homenaje a Paco de Lucía',
          programText: 'A Fernanda (Rondeña); Meraki (Bulerías); Ecdysis (Farruca).',
        }),
      ).eligibility.value,
    ).toBe('exclude');
  });

  it('no excluye por flamenco la escuela franco-flamenca ni el Códice de Chigi', () => {
    const chigi = classify(
      facts({
        title: 'OCNE. Satélite 08. Chigi Codex',
        description: 'Música de compositores flamencos del Códice de Chigi (ca. 1498).',
        categoryText: 'OCNE Satélite',
        performers: [{ name: 'Coro Nacional de España' }],
      }),
    );
    expect(chigi.eligibility.value).not.toBe('exclude');
    expect(chigi.eligibility.ruleId).not.toBe('flamenco-identity');

    const franco = classify(
      facts({
        title: 'Polifonía de la escuela franco-flamenca',
        description: 'Programa de polifonía flamenca del Renacimiento.',
      }),
    );
    expect(franco.eligibility.value).not.toBe('exclude');
    expect(franco.eligibility.ruleId).not.toBe('flamenco-identity');
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

  it('incluye compositores conocidos presentes en programText aunque no vengan en composers[]', () => {
    for (const name of ['Brahms', 'Mahler', 'Mendelssohn', 'Bach']) {
      const result = classify(
        facts({
          title: 'Concierto de temporada',
          programText: `${name}: obra del programa.`,
        }),
      );
      expect(result.eligibility.value, name).toBe('include');
      expect(result.eligibility.ruleId, name).toBe('known-classical-composer');
    }
  });

  it.each([
    ['Giovanni Battista Mele', 'baroque'],
    ['Luis Misón', 'baroque'],
    ['Francesco Federici', 'classical'],
    ['Felipe Libón', 'classical'],
    ['Gioachino Rossini', 'romantic'],
    ['Johann Strauss II', 'romantic'],
    ['Ralph Vaughan Williams', 'twentieth'],
    ['Carl Orff', 'twentieth'],
    ['Kurt Weill', 'twentieth'],
    ['A. Ginastera', 'twentieth'],
    ['Luis Gianneo', 'twentieth'],
    ['Steve Reich', 'contemporary'],
    ['Philip Glass', 'contemporary'],
    ['Olivier Messiaen', 'twentieth'],
    ['Alexander Scriabin', 'twentieth'],
    ['Richard Strauss', 'romantic'],
    ['Vincenzo Bellini', 'romantic'],
    ['Domenico Scarlatti', 'baroque'],
    ['Alicia Terzian', 'contemporary'],
    ['Irma Urteaga', 'contemporary'],
    ['Francesc Vila', 'contemporary'],
    ['M. Sotelo', 'contemporary'],
    ['Unsuk Chin', 'contemporary'],
    ['Carlos Simon', 'contemporary'],
  ])('reconoce el compositor observado en la temporada oficial: %s', (name, era) => {
    const result = classify(facts({
      title: 'Concierto de temporada',
      programText: `${name}: obra del programa.`,
    }));
    expect(result.eligibility).toMatchObject({
      value: 'include',
      ruleId: 'known-classical-composer',
    });
    expect(result.eras?.value).toContain(era);
  });

  it('un compositor clásico en el programa no gana a jazz, pop, taller o danza', () => {
    expect(
      classify(
        facts({
          title: 'Jazz en el Auditorio',
          categoryText: 'Jazz en el Auditorio',
          programText: 'Brahms y estándares de jazz.',
        }),
      ).eligibility.ruleId,
    ).toBe('jazz-identity');

    expect(
      classify(
        facts({
          title: 'ABBA, Queen, Beatles y Otros Grandes del Pop',
          programText: 'También un arreglo de Bach.',
          performers: [{ name: 'Pop Orchestra', roleText: 'orquesta' }],
        }),
      ).eligibility.ruleId,
    ).toBe('popular-music-identity');

    expect(
      classify(
        facts({
          title: '¿Te suena Manon Lescaut, de G. Puccini?',
          categoryText: 'Taller musical en familia',
          programText: 'Puccini: Manon Lescaut.',
        }),
      ).eligibility.ruleId,
    ).toBe('non-performance-activity');

    expect(
      classify(
        facts({
          title: '¿Te suena Manon Lescaut, de G. Puccini?',
          categoryText: 'El Real Junior',
          description: 'Taller musical en familia',
          programText: 'Taller musical en familia. Puccini: Manon Lescaut.',
        }),
      ).eligibility,
    ).toMatchObject({ value: 'exclude', ruleId: 'non-performance-activity' });
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

  it('incluye un concierto mixto con bloque clásico autónomo en un concierto sinfónico real', () => {
    const result = classify(
      facts({
        title: 'UAM. Raíces Sinfónicas. Gran Fiesta Canaria',
        seriesText: 'Ciclo de Grandes Autores e Intérpretes de la Música',
        programText:
          'Primera parte: Saint-Saëns y Falla. Segunda parte: repertorio canario de Los Sabandeños.',
        performers: [
          { name: 'Joven Orquesta de Canarias' },
          { name: 'Los Sabandeños' },
          { name: 'Juan Pérez Floristán', roleText: 'piano' },
        ],
        composers: [{ name: 'Camille Saint-Saëns' }, { name: 'Manuel de Falla' }, { name: 'Silvio Rodríguez' }],
        works: [
          { title: 'Noches en los Jardines de España', composerName: 'Manuel de Falla' },
          { title: 'Unicornio', composerName: 'Silvio Rodríguez' },
        ],
      }),
    );
    expect(result.eligibility.value).toBe('include');
  });

  it('Mompou — Música callada (1959–1967) es twentieth, no contemporary', () => {
    const result = classify(
      facts({
        title: 'Mario Prisuelos. Música callada de Frederic Mompou',
        description:
          'Música callada de Frederic Mompou es una obra cumbre para piano dividida en 28 piezas agrupadas en cuatro cuadernos compuestos entre 1959 y 1967.',
        programText: 'Música callada de Frederic Mompou.',
        performers: [{ name: 'Mario Prisuelos', roleText: 'piano' }],
        composers: [{ name: 'Frederic Mompou' }],
        works: [{ title: 'Música callada', composerName: 'Frederic Mompou' }],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.eras?.value).toEqual(['twentieth']);
    expect(result.eras?.value).not.toContain('contemporary');
  });

  it('un programa mixto con bloque clásico sustancial sigue siendo include', () => {
    const result = classify(
      facts({
        title: "APOLLO5 – 'A Day in Paradise'",
        seriesText: 'Ciclo de música de cámara Salón del Ateneo',
        description:
          'El quinteto vocal británico APOLLO5 presenta un programa de Renacimiento a pop. Obras de Morley, Monteverdi, Grieg, Gershwin, Whitacre, Saint-Saëns, Tom Petty y otros.',
        programText:
          'Thomas Morley: Arise, Awake. Claudio Monteverdi: Sfogava con le stelle. Edvard Grieg: Våren. Camille Saint-Saëns: Les fleurs et les arbres. George Gershwin: Summertime. Tom Petty: Wildflowers. Bill Withers: Lovely Day.',
        performers: [{ name: 'APOLLO5' }],
        composers: [
          { name: 'Thomas Morley' },
          { name: 'Claudio Monteverdi' },
          { name: 'Edvard Grieg' },
          { name: 'Camille Saint-Saëns' },
          { name: 'George Gershwin' },
          { name: 'Tom Petty' },
          { name: 'Bill Withers' },
        ],
        works: [
          { title: 'Arise, Awake', composerName: 'Thomas Morley' },
          { title: 'Sfogava con le stelle', composerName: 'Claudio Monteverdi' },
          { title: 'Les fleurs et les arbres', composerName: 'Camille Saint-Saëns' },
          { title: 'Wildflowers', composerName: 'Tom Petty' },
        ],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.ruleId).toBe('mixed-program-classical-block');
  });

  it('un programa pop-dominante con una sola referencia clásica no es include automático', () => {
    const result = classify(
      facts({
        title: 'Tribute to Tom Petty',
        programText: 'Free Fallin’; Refugee; El cisne de Saint-Saëns.',
        composers: [{ name: 'Tom Petty' }, { name: 'Camille Saint-Saëns' }],
        works: [
          { title: 'Free Fallin’', composerName: 'Tom Petty' },
          { title: 'Le cygne', composerName: 'Camille Saint-Saëns' },
        ],
        performers: [{ name: 'Pop Chamber Ensemble' }],
      }),
    );
    expect(result.eligibility.value).not.toBe('include');
    expect(result.eligibility.ruleId).not.toBe('known-classical-composer');
  });

  it('no convierte ABBA con orquesta ni un tributo de cine en include', () => {
    const abba = classify(
      facts({
        title: 'ABBA, Queen, Beatles y Otros Grandes del Pop',
        performers: [{ name: 'Pop Orchestra', roleText: 'orquesta' }],
      }),
    );
    expect(abba.eligibility.value).toBe('exclude');

    const zimmer = classify(
      facts({
        title: 'Candlelight: Tributo a Hans Zimmer',
        composers: [{ name: 'Hans Zimmer' }],
        programText: 'Time; El rey león; Interstellar',
      }),
    );
    expect(zimmer.eligibility.value).toBe('exclude');
    expect(zimmer.eligibility.ruleId).toBe('film-music-identity');
  });

  it('incluye repertorio de piano contemporáneo/neoclásico de tradición concertística', () => {
    const result = classify(
      facts({
        title: 'Candlelight: Tributo a Ludovico Einaudi',
        composers: [{ name: 'Ludovico Einaudi' }],
        works: [{ title: 'Nuvole Bianche', composerName: 'Ludovico Einaudi' }],
        performers: [{ name: 'Esther Toledano', roleText: 'piano' }],
      }),
    );
    expect(result.eligibility.value).toBe('include');
  });

  it('incluye un concierto declarado explícitamente como música clásica sin programa completo', () => {
    const result = classify(
      facts({
        title: 'Trilogía andaluza',
        description:
          'Concierto de música clásica española. Concierto ilustrado con fotografías, narrado y cantado.',
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.ruleId).toBe('explicit-classical-concert');
  });

  it('no incluye solo por un título ambiguo que parezca clásico', () => {
    expect(classify(facts({ title: 'Concierto de Navidad' })).eligibility.value).not.toBe('include');
    expect(classify(facts({ title: 'Gala de música' })).eligibility.value).not.toBe('include');
  });

  it('excluye jazz CNDM / Miles Davis y un musical de Broadway con orquesta', () => {
    expect(
      classify(
        facts({
          title: 'CNDM. Julián Sánchez Quintet',
          programText: 'Los sonidos de Miles Davis',
        }),
      ).eligibility.value,
    ).toBe('exclude');

    expect(
      classify(
        facts({
          title: 'UPM. Musicales en Concierto',
          programText: 'Broadway Showstoppers. My Fair Lady. Chicago.',
          performers: [{ name: 'Orquesta Metropolitana de Madrid' }],
        }),
      ).eligibility.value,
    ).toBe('exclude');
  });

  it('un mixto coprincipal barroco+flamenco no se excluye automáticamente', () => {
    const sarao = classify(
      facts({
        title: 'Sarao Barroco',
        description:
          'En Sarao barroco, Andreas Prittwitz y el ensamble Lookingback nos invitan a descubrir el pulso festivo del Barroco y el flamenco.',
        performers: [
          { name: 'Eva Durán', roleText: 'cante' },
          { name: 'José Almarcha', roleText: 'guitarra flamenca' },
          { name: 'Ramiro Morales', roleText: 'guitarra barroca' },
        ],
      }),
    );
    expect(sarao.eligibility.value).not.toBe('exclude');
    expect(sarao.eligibility.value).toBe('uncertain');
  });

  it('incluye un concierto de ciclo clásico sin programa obra-por-obra', () => {
    const chamber = classify(
      facts({
        title: 'Domingos de Cámara I',
        categoryText: 'Domingos de Cámara',
        description:
          'Los solistas de la Orquesta Titular del Teatro Real ofrecerán una serie de conciertos.',
        performers: [{ name: 'solistas de la Orquesta Titular del Teatro Real' }],
      }),
    );
    expect(chamber.eligibility.value).toBe('include');
    expect(chamber.eligibility.ruleId).toBe('classical-concert-series');

    const festival = classify(
      facts({
        title: 'Madrid a Tempo: Concierto de inauguración',
        seriesText: 'Festival Internacional de Piano Madrid a Tempo',
      }),
    );
    expect(festival.eligibility.value).toBe('include');
    expect(festival.eligibility.ruleId).toBe('classical-concert-series');

    const organ = classify(
      facts({
        title: 'Concierto de Mineko Kojima',
        categoryText: 'Ciclo Internacional de Órgano; Conciertos',
        seriesText: 'Ciclo Internacional de Órgano',
        venueText: 'Basílica Pontificia de San Miguel',
      }),
    );
    expect(organ.eligibility.value).toBe('include');
    expect(organ.eligibility.ruleId).toBe('classical-concert-series');
    expect(organ.kind.value).toBe('alternative');
    expect(organ.formats.value).toContain('organ');
  });

  it('incluye ciclos clásicos cuyo título es sólo el intérprete', () => {
    const universo = classify(
      facts({
        title: 'COLLEGIUM VOCALE GENT',
        seriesText: 'Universo Barroco',
        composers: [{ name: 'Carlo Gesualdo (1566-1613)' }],
      }),
    );
    expect(universo.eligibility.value).toBe('include');
    expect(universo.eligibility.ruleId).toBe('classical-concert-series');

    const lied = classify(
      facts({
        title: 'Adriana González y Marina Viotti',
        categoryText: 'XXXIII Ciclo de Lied',
        venueText: 'Teatro de la Zarzuela',
      }),
    );
    expect(lied.eligibility.value).toBe('include');
    expect(lied.eligibility.ruleId).toBe('classical-concert-series');
    expect(lied.formats.value).toContain('lied');

    const liceo = classify(
      facts({
        title: 'ANA MARÍA VALDERRAMA & JUDITH JÁUREGUI',
        seriesText: 'Liceo de Cámara XXI',
      }),
    );
    expect(liceo.eligibility.value).toBe('include');
    expect(liceo.eligibility.ruleId).toBe('classical-concert-series');
  });

  it('incluye ciclos del Auditorio cuyo título lleva el nombre de la serie', () => {
    const ibermusica = classify(
      facts({
        title: 'Ibermúsica. Niños Cantores de Viena',
        venueText: 'Sala Sinfónica',
        programText: 'Manolo Cagnin, dirección',
        performers: [{ name: 'Manolo Cagnin', roleText: 'dirección' }],
      }),
    );
    expect(ibermusica.eligibility.value).toBe('include');
    expect(ibermusica.eligibility.ruleId).toBe('classical-concert-series');
    expect(ibermusica.kind.value).toBe('established');

    const visitingOrchestra = classify(
      facts({
        title: 'Ibermúsica. Deutsche Radio Philharmonie',
        venueText: 'Sala Sinfónica',
        programText:
          'Josep Pons, dirección. WAGNER Preludio y muerte Tristán e Isolda. STRAUSS Cuatro últimas canciones.',
      }),
    );
    expect(visitingOrchestra.eligibility.value).toBe('include');
    expect(visitingOrchestra.eligibility.ruleId).toBe('classical-concert-series');

    const scherzo = classify(
      facts({
        title: 'Fundación Scherzo. Grigory Sokolov',
        venueText: 'Sala Sinfónica',
        programText: 'Grigory Sokolov, piano. Programa pendiente de confirmación',
        performers: [{ name: 'Grigory Sokolov', roleText: 'piano' }],
      }),
    );
    expect(scherzo.eligibility.value).toBe('include');
    expect(scherzo.eligibility.ruleId).toBe('classical-concert-series');

    const ocne = classify(
      facts({
        title: 'OCNE. Sinfónico 09',
        venueText: 'Sala Sinfónica',
        composers: [{ name: 'Benjamin Britten' }, { name: 'Edward Elgar' }],
        programText:
          'Caroline Shaw. Entr’acte, para orquesta de cuerda. Benjamin Britten. Concierto para piano núm. 1, op. 13.',
      }),
    );
    expect(ocne.eligibility.value).toBe('include');
    expect(ocne.eligibility.ruleId).toBe('known-classical-composer');
    expect(ocne.eras.value).toEqual(expect.arrayContaining(['twentieth', 'romantic']));

    const larrocha = classify(
      facts({
        title: 'IV FESTIVAL ALICIA DE LARROCHA - ALUMNOS DEL PROFESOR FRANCISCO FIERRO',
        venueText: 'Centro Cultural Casa de Vacas',
      }),
    );
    expect(larrocha.eligibility.value).toBe('include');
    expect(larrocha.eligibility.ruleId).toBe('classical-concert-series');
  });

  it('no trata un código de temporada OCNE o un Satélite gospel como ciclo clásico', () => {
    const coded = classify(
      facts({
        title: 'OCNE. Sinfónico 03',
        venueText: 'Sala Sinfónica',
      }),
    );
    expect(coded.eligibility.value).toBe('uncertain');

    const gospel = classify(
      facts({
        title: 'OCNE. Satélite 16 Gospel, Taking Its Place',
        venueText: 'Sala Sinfónica',
      }),
    );
    expect(gospel.eligibility.value).not.toBe('include');
  });

  it('no infiere include por un recital Impacta sin repertorio ni por un gala Bernstein-Gershwin', () => {
    const bartoli = classify(
      facts({
        title: 'Impacta. Cecilia Bartoli y Lang Lang',
        programText: 'Cecilia Bartoli, mezzosoprano. Lang Lang, piano. Recital de voz y piano.',
        performers: [
          { name: 'Cecilia Bartoli', roleText: 'mezzosoprano' },
          { name: 'Lang Lang', roleText: 'piano' },
        ],
      }),
    );
    expect(bartoli.eligibility.value).toBe('uncertain');

    const rhapsody = classify(
      facts({
        title: 'La Filarmónica. Rhapsody In Blue',
        programText:
          'Bernstein, Wonderful town. Gershwin, Rhapsody in blue. Bernstein, Candide. Bernstein-Gershwin, Summertime.',
      }),
    );
    expect(rhapsody.eligibility.value).not.toBe('include');
  });

  it('incluye un recital CNDM cuando la ficha declara Messiaen y Scriabin', () => {
    const result = classify(
      facts({
        title: 'BARBARA HANNIGAN & BERTRAND CHAMAYOU',
        composers: [
          { name: 'Olivier Messiaen (1908-1992)' },
          { name: 'Alexander Scriabin (1872-1915)' },
          { name: 'John Zorn (1953)' },
        ],
        works: [
          { title: 'Chants de terre et de ciel (1938)', composerName: 'Olivier Messiaen (1908-1992)' },
          { title: 'Poème-nocturne, op. 61 (1911)', composerName: 'Alexander Scriabin (1872-1915)' },
        ],
        performers: [
          { name: 'Barbara Hannigan', roleText: 'soprano' },
          { name: 'Bertrand Chamayou', roleText: 'piano' },
        ],
      }),
    );
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.ruleId).toBe('known-classical-composer');
    expect(result.eligibility.evidence).toEqual(
      expect.arrayContaining(['Olivier Messiaen', 'Alexander Scriabin']),
    );
  });

  it('incluye la temporada de lírica y no una charla que menciona el ciclo', () => {
    const lirica = classify(
      facts({
        title: 'Los gavilanes',
        categoryText: 'Lírica',
        composers: [{ name: 'JACINTO GUERRERO' }],
        venueText: 'Teatro de la Zarzuela',
      }),
    );
    expect(lirica.eligibility.value).toBe('include');
    expect(lirica.eligibility.ruleId).toBe('lyric-theatre-event');
    expect(lirica.kind.value).toBe('established');

    const talk = classify(
      facts({
        title: 'Contextos Barrocos: Charla sobre el concierto de Collegium Vocale 1704',
        seriesText: 'Educación',
        description:
          'Charlas previas al ciclo de conciertos de Universo Barroco en la Sala Sinfónica del Auditorio Nacional de Música.',
      }),
    );
    expect(talk.eligibility.value).toBe('exclude');
    expect(talk.eligibility.ruleId).toBe('non-performance-activity');
  });

  it('incluye títulos oficiales que declaran ópera y dos entregas inequívocas de Miniclásica', () => {
    for (const observed of [
      facts({ title: 'Excelentia. Arias de Ópera Italianas' }),
      facts({ title: 'Filarmonía de Madrid. Gala de Ópera' }),
      facts({ title: 'Micróperas', description: 'Óperas de nueva creación para niños y niñas.' }),
      facts({ title: 'Miniclásica: Descubriendo el Clasicismo' }),
      facts({ title: 'Miniclásica: Descubriendo la música antigua' }),
    ]) {
      expect(classify(observed).eligibility.value, observed.title).toBe('include');
    }
  });

  it('incluye COMA y una categoría explícita de música clásica, y sigue excluyendo jazz en un ciclo mixto', () => {
    const coma = classify(
      facts({
        title: "COMA'26: ATLÁNTIDA CHAMBER ORCHESTRA",
        categoryText: 'Música – Entrada libre hasta completar aforo',
        description: 'El Festival COMA sigue creciendo en prestigio año tras año, con la panorámica de música actual.',
      }),
    );
    expect(coma.eligibility.value).toBe('include');
    expect(coma.eligibility.ruleId).toBe('academic-contemporary');

    const camerata = classify(
      facts({
        title: 'Joven Camerata de la ORCAM',
        categoryText: 'Música clásica',
      }),
    );
    expect(camerata.eligibility.value).toBe('include');
    expect(camerata.eligibility.ruleId).toBe('explicit-classical-concert');

    const jazz = classify(
      facts({
        title: 'FAZIL SAY, ASLIHAN AND SAY',
        seriesText: 'Fronteras',
        description: 'Un concierto de jazz contemporáneo en el Auditorio Nacional.',
      }),
    );
    expect(jazz.eligibility.value).toBe('exclude');
    expect(jazz.eligibility.ruleId).toBe('jazz-identity');
  });

  it('excluye open piano y jam participativa aunque el festival sea de piano clásico', () => {
    const openPiano = classify(
      facts({
        title: 'Madrid a Tempo: Open Piano',
        description: 'Open Piano/Piano al aire libre',
        seriesText: 'Festival Internacional de Piano Madrid a Tempo',
      }),
    );
    expect(openPiano.eligibility.value).toBe('exclude');
    expect(openPiano.eligibility.ruleId).toBe('participatory-activity');

    const jam = classify(
      facts({
        title: 'Jam participativa de piano',
        seriesText: 'Festival Internacional de Piano',
      }),
    );
    expect(jam.eligibility.value).toBe('exclude');
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

    const mixedFilm = classify(
      facts({
        title: 'Los sonidos del universo',
        categoryText: 'Actuación música / Música clásica',
        description:
          'Un recorrido por grandes obras de la música clásica y las bandas sonoras más emblemáticas del cine.',
      }),
    );
    expect(mixedFilm.eligibility.value).not.toBe('exclude');
    expect(mixedFilm.eligibility.value).toBe('uncertain');
    expect(mixedFilm.eligibility.ruleId).toBe('classical-and-nonclassical-coprincipal');
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

describe('eras', () => {
  it('deriva épocas de compositores y de programText cuando el programa los nombra', () => {
    expect(
      resolveEras(
        facts({
          title: 'Bach',
          composers: [{ name: 'Johann Sebastian Bach' }],
        }),
      ).value,
    ).toEqual(['baroque']);

    expect(
      resolveEras(
        facts({
          title: 'Clasicismo',
          programText: 'Mozart: Divertimento. Haydn: Cuarteto op. 20.',
        }),
      ).value,
    ).toEqual(['classical']);

    expect(
      resolveEras(
        facts({
          title: 'Romanticismo',
          programText: 'Brahms, Sinfonía núm. 4. Mahler, Sinfonía núm. 3.',
        }),
      ).value,
    ).toEqual(['romantic']);

    expect(
      resolveEras(
        facts({
          title: 'Mixto',
          programText: 'Bach: Suite. Mozart: Concierto. Brahms: Sinfonía.',
        }),
      ).value,
    ).toEqual(['baroque', 'classical', 'romantic']);

    expect(resolveEras(facts({ title: 'Concierto extraordinario' })).value).toEqual([]);
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

  it('alinea opera/recital/choral/symphonic con hechos ya extraídos, sin inventar era', () => {
    expect(
      resolveFormats(facts({ title: 'Filarmonía de Madrid. Gala de Ópera' })).value,
    ).toEqual(['opera']);
    expect(
      resolveFormats(facts({ title: 'Micróperas', categoryText: 'El Real Junior' })).value,
    ).toEqual(['opera']);
    expect(
      resolveFormats(
        facts({
          title: 'CNDM. Diego Ares',
          performers: [{ name: 'DIEGO ARES', roleText: 'clave' }],
        }),
      ).value,
    ).toEqual(['recital']);
    expect(
      resolveFormats(
        facts({
          title: 'Impacta. Pasión según San Mateo, J.S. Bach',
          performers: [
            { name: 'Freiburg Baroque Orchestra' },
            { name: 'Pequeños Cantores de la ORCAM' },
          ],
        }),
      ).value.sort(),
    ).toEqual(['choral', 'symphonic']);
    expect(
      resolveFormats(
        facts({
          title: 'UAM. Missa Papae Marcelli',
          performers: [{ name: 'Schola Cantorum UAM' }],
        }),
      ).value,
    ).toEqual(['choral']);
  });

  it('asigna chamber/symphonic a categorías municipales inequívocas', () => {
    expect(
      resolveFormats(
        facts({
          title: 'Ciclo de temporada',
          categoryText: 'camara',
        }),
      ).value,
    ).toEqual(['chamber']);

    expect(
      resolveFormats(
        facts({
          title: 'OCNE Satélite',
          categoryText: 'sinfonica',
        }),
      ).value,
    ).toEqual(['symphonic']);

    expect(
      resolveFormats(
        facts({
          title: 'Trilogía andaluza',
          description: 'Concierto de música clásica española.',
        }),
      ).value,
    ).toEqual([]);
  });

  it('no infiere symphonic ni chamber de la sala del Auditorio Nacional', () => {
    expect(
      resolveFormats(
        facts({
          title: 'Excelentia. Concierto de Año Nuevo',
          venueText: 'Sala Sinfónica',
        }),
      ).value,
    ).toEqual([]);

    expect(
      resolveFormats(
        facts({
          title: 'Excelentia. Lo Mejor de los Tres Tenores',
          venueText: 'Sala de Cámara',
        }),
      ).value,
    ).toEqual([]);
  });

  it('sigue infiriendo format cuando hay evidencia musical real, no por la sala', () => {
    expect(
      resolveFormats(
        facts({
          title: 'Excelentia. Concierto de Año Nuevo',
          venueText: 'Sala Sinfónica',
          performers: [{ name: 'Orquesta Clásica Santa Cecilia' }],
        }),
      ).value,
    ).toEqual(['symphonic']);

    expect(
      resolveFormats(
        facts({
          title: 'CNDM. Cuarteto Casals',
          venueText: 'Sala de Cámara',
          performers: [{ name: 'Cuarteto Casals', roleText: 'cuarteto' }],
        }),
      ).value,
    ).toEqual(['chamber']);

    expect(
      resolveFormats(
        facts({
          title: 'Canto y piano',
          venueText: 'Sala de Cámara',
          performers: [
            { name: 'Ana Pérez', roleText: 'soprano' },
            { name: 'Luis Gómez', roleText: 'piano' },
          ],
        }),
      ).value,
    ).toEqual(['recital']);
  });

  it('varios cantantes con piano no se fuerzan a recital ni a chamber por la sala', () => {
    expect(
      resolveFormats(
        facts({
          title: 'Excelentia. Lo Mejor de los Tres Tenores',
          venueText: 'Sala de Cámara',
          performers: [
            { name: 'Miguel Borrallo', roleText: 'tenor' },
            { name: 'Eduardo Sandoval', roleText: 'tenor' },
            { name: 'Sergio Escobar', roleText: 'tenor' },
            { name: 'Francisco Pérez Sánchez', roleText: 'piano' },
          ],
        }),
      ).value,
    ).toEqual([]);
  });

});

describe('kind', () => {
  it('usa el venue canónico, no el sourceId ni el texto del programa', () => {
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
  });

  it('clasifica Real Teatro de Retiro como circuito habitual, no como Teatro Real', () => {
    const result = resolveKind(
      facts({
        title: 'Miniclásica',
        venueText: 'HALL Real Teatro de Retiro',
      }),
    );
    expect(result.value).toBe('established');
    expect(result.evidence.join(' ')).toMatch(/retiro/i);
    expect(result.evidence).not.toContain('ven_teatro_real');
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
