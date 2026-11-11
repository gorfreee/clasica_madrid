import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveEligibility } from '../src/ingestion/classification/eligibility.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { evaluateEligibilityAi } from '../src/ingestion/classification/eligibility-grounding.ts';
import { findKnownComposersInText } from '../src/ingestion/knowledge/composers.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const run43056214891 = JSON.parse(readFileSync(new URL(
  './fixtures/ingestion/eligibility-context/run-43056214891.json', import.meta.url,
), 'utf8')) as Array<{
  sourceUrl: string;
  observed: ObservedFacts;
  originalDecision: { value: string; ruleId: string };
}>;

const originals = JSON.parse(readFileSync(new URL(
  './fixtures/ingestion/eligibility-context/run-39603845469.json', import.meta.url,
), 'utf8')) as Array<{
  sourceUrl: string;
  observed: ObservedFacts;
  originalEligibility: { value: string; ruleId: string };
}>;

const facts = (overrides: Partial<ObservedFacts> = {}): ObservedFacts => ({
  title: 'Velada musical', performers: [], composers: [], works: [], ...overrides,
});

describe('eligibility: observaciones originales del run 39603845469', () => {
  it.each(originals)('$observed.title no queda excluido por una mención incidental', (row) => {
    expect(row.originalEligibility.value).toBe('exclude');
    const result = resolveEligibility(row.observed);
    expect(result.value).not.toBe('exclude');
    // The original observation is used verbatim, without the curated data/**.
    if (
      /lucia-iglesias|donde-nace-la-voz|xxxi-concierto-navidad/.test(row.sourceUrl)
      || row.observed.title === 'Todo Chapí'
    ) {
      expect(result.value).toBe('include');
    } else {
      expect(result.value).toBe('uncertain');
    }
  });

  it('reconoce el concierto de Cofares aunque el crédito diga Rachmaninov.-', () => {
    const original = originals.find((row) => row.sourceUrl.endsWith('xxxi-concierto-navidad'))!.observed;
    expect(original.composers).toEqual([]);
    expect(original.works).toEqual([]);
    expect(original.programText).toContain('Piano Rachmaninov.- Concierto para piano núm 3');
    expect(resolveEligibility(original)).toMatchObject({
      value: 'include', ruleId: 'mixed-program-classical-block',
    });
  });
});

describe('actividad principal frente a contexto', () => {
  const bach = { programText: 'Johann Sebastian Bach: Suite BWV 1007.' };

  it.each(['mayor proyección de su generación', 'proyección internacional', 'proyección de su carrera'])(
    'no convierte la biografía «%s» en una película ni en repertorio', (phrase) => {
      const bio = facts({ description: `Una intérprete con ${phrase}.` });
      expect(resolveEligibility(bio).value).toBe('uncertain');
      expect(resolveEligibility({ ...bio, ...bach }).value).toBe('include');
    },
  );

  it('no convierte cine en acción de proyectar, pero conserva una proyección real con órgano', () => {
    expect(resolveEligibility(facts({ title: 'Un piano de cine', ...bach })).value).toBe('include');
    const screening = facts({
      title: 'Nosferatu', categoryText: 'Música',
      description: 'Proyección de la película muda con acompañamiento de órgano.',
      performers: [{ name: 'Organista invitado', roleText: 'órgano' }], ...bach,
    });
    expect(resolveEligibility(screening)).toMatchObject({
      value: 'exclude', ruleId: 'cinema-projection',
      evidence: ['description: Proyección de la película muda con acompañamiento de órgano.'],
    });
    expect(resolveEligibility({
      ...screening, title: 'Proyección de Nosferatu', categoryText: 'Concierto en familia',
    }).value).toBe('exclude');
    expect(resolveEligibility(facts({
      programText: 'Proyección de Nosferatu con acompañamiento de órgano.',
      performers: screening.performers,
    }))).toMatchObject({ value: 'exclude', ruleId: 'cinema-projection' });
  });

  it.each(['Cía.', 'Compañía', 'Grupo', 'Ensemble'])(
    '%s Taller nombra una formación, y no oculta un taller real posterior', (prefix) => {
      const company = facts({ title: `${prefix} Taller de Música`, ...bach });
      expect(resolveEligibility(company).value).toBe('include');
      const activity = facts({
        title: 'Exploración sonora',
        description: `${prefix} Taller de Música. Un taller de iniciación para aprender en familia.`,
        ...bach,
      });
      expect(resolveEligibility(activity)).toMatchObject({
        value: 'exclude', ruleId: 'non-performance-activity',
      });
    },
  );

  it('un taller explícito prevalece aunque tenga compañía y programa clásico', () => {
    const result = resolveEligibility(facts({
      title: 'Un viaje sonoro', categoryText: 'Taller de música',
      performers: [{ name: 'Taller de Música' }], ...bach,
    }));
    expect(result).toMatchObject({ value: 'exclude', ruleId: 'non-performance-activity' });
    expect(result.evidence).toContain('categoryText: Taller de música');
    expect(result.evidence).not.toContain('Un viaje sonoro');
  });

  it.each(['Film Symphony Orchestra', 'Royal Film Concert Orchestra', 'ABBA Ensemble'])(
    'no decide el repertorio por el crédito %s', (name) => {
      const credit = facts({
        title: `${name}: concierto`, organizerText: name,
        performers: [{ name, roleText: 'orquesta' }],
      });
      expect(resolveEligibility(credit).value).toBe('uncertain');
      expect(resolveEligibility({ ...credit, ...bach }).value).toBe('include');
    },
  );

  it.each(['Hans Zimmer', 'John Williams', 'Ennio Morricone'])(
    '%s solo no acredita predominio de bandas sonoras; un tributo explícito sí', (name) => {
      expect(resolveEligibility(facts({ composers: [{ name }] })).value).toBe('uncertain');
      expect(resolveEligibility(facts({ title: `Tributo a ${name}` }))).toMatchObject({
        value: 'exclude', ruleId: 'film-music-identity',
      });
      expect(resolveEligibility(facts({ title: 'Gala de bandas sonoras', composers: [{ name }] }))).toMatchObject({
        value: 'exclude', ruleId: 'film-music-identity',
      });
    },
  );

  it.each(['ABBA', 'Queen', 'Beatles'])(
    'mantiene %s con orquesta fuera si no tiene bloque clásico', (name) => {
      const popular = facts({
        title: `Tributo a ${name}`, programText: `Éxitos de ${name}.`,
        performers: [{ name: 'Orquesta Clásica', roleText: 'orquesta' }],
      });
      expect(resolveEligibility(popular)).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
      expect(resolveEligibility({ ...popular, programText: `${popular.programText} También un arreglo de Bach.` }).value)
        .toBe('exclude');
      expect(resolveEligibility({ ...popular, programText: `${popular.programText} Primera parte: Bach: Suite BWV 1007. Segunda parte: éxitos.` }))
        .toMatchObject({ value: 'include', ruleId: 'mixed-program-classical-block' });
    },
  );

  it('no convierte una película o ballet en concierto por un programa clásico completo', () => {
    const classical = {
      programText: 'Johann Sebastian Bach: Suite. Ludwig van Beethoven: Sinfonía nº 7.',
      composers: [{ name: 'Johann Sebastian Bach' }, { name: 'Ludwig van Beethoven' }],
      performers: [{ name: 'Orquesta', roleText: 'orquesta' }],
    };
    expect(resolveEligibility(facts({ ...classical, title: 'Gala de ballet', categoryText: 'Ballet' })).value).toBe('exclude');
    expect(resolveEligibility(facts({ ...classical, title: 'Proyección de Nosferatu' })).value).toBe('exclude');
  });

  it('el órgano y el título concierto no son un bloque clásico de un tributo pop', () => {
    expect(resolveEligibility(facts({
      title: 'Concierto de ABBA', programText: 'ABBA: Mamma Mia.',
      performers: [{ name: 'Organista invitado', roleText: 'órgano' }],
    }))).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
  });

  it('una actividad docente pasada en una biografía no convierte el recital en taller', () => {
    expect(resolveEligibility(facts({
      description: 'Ha impartido un taller de iniciación. Hoy interpreta la Suite BWV 1007.',
      ...bach,
    })).value).toBe('include');
  });

  it('no usa créditos, biografías o fronteras entre campos para inventar identidad o bloque clásico', () => {
    const incidental = facts({
      ...bach,
      description: 'Ha trabajado en bandas sonoras con Hans Zimmer y ABBA. Su carrera tiene proyección internacional.',
      organizerText: 'Film Symphony Orchestra',
    });
    expect(resolveEligibility(incidental).value).toBe('include');
    expect(resolveEligibility(facts({
      title: 'Bandas', organizerText: 'sonoras', performers: [{ name: 'John Williams' }],
    })).value).toBe('uncertain');
    expect(resolveEligibility(facts({
      title: 'Gala de bandas sonoras',
      description: 'Ha interpretado obras de Bach y Beethoven en su carrera.',
      programText: 'Bandas sonoras de Star Wars e Indiana Jones.',
    })).value).not.toBe('include');
  });

  it('la traza de cine/pop cita el campo y el literal que disparó la regla', () => {
    for (const [programText, ruleId] of [
      ['Bandas sonoras de Star Wars.', 'film-music-identity'],
      ['ABBA: Mamma Mia.', 'popular-music-identity'],
    ]) {
      expect(resolveEligibility(facts({ categoryText: 'Música', programText }))).toMatchObject({
        value: 'exclude', ruleId, evidence: [`programText: ${programText}`],
      });
    }
  });

  it('no reabre excludes con IA y sigue exigiendo spans literales en uncertain', async () => {
    const classify = vi.fn();
    await classifyObserved(facts({ title: 'Tributo a ABBA' }), { ai: { classify } });
    expect(classify).not.toHaveBeenCalled();
    const herrmann = originals.find((row) => row.sourceUrl.includes('no-solo-cine'))!.observed;
    expect(evaluateEligibilityAi(herrmann, {
      eligibility: 'include', evidence: ['Un concierto de música clásica de cámara'],
    }, resolveEligibility(herrmann))).toMatchObject({ accepted: false, ruleId: 'ai-ungrounded-evidence' });
    const fso = originals.find((row) => row.sourceUrl.includes('clasictacular'))!.observed;
    expect(evaluateEligibilityAi(fso, {
      eligibility: 'include', evidence: ['OBERTURA 1812'],
    }, resolveEligibility(fso))).toMatchObject({ accepted: false, ruleId: 'ai-coprincipal-without-classical-block' });
  });
});

describe('run 43056214891: danza secundaria frente a ballet principal', () => {
  const janacek = run43056214891.find((row) => row.sourceUrl.includes('diario-desaparecido'))!;

  it.each([
    'Leoš Janáček: Cuarteto de cuerda nº 2, JW VII/13. Nota: JW VII/13.',
    'Leoš Janáček\nCuarteto de cuerda nº 2, JW VII/13\nJW VII/13',
    'Leoš Janáček\nCuarteto de cuerda nº 2, JW VII/13\nOtra edición del cuarteto, JW VII/13',
    'Leoš Janáček\nCuarteto de cuerda nº 2, JW VII/13\nCuarteto de cuerda nº 2, JW VIII/33',
    'Leoš Janáček: Una sola entrada con JW VII/13 y JW VIII/33.',
    'Comentario sobre Leoš Janáček\nPrimera pieza, JW VII/13\nSegunda pieza, JW VIII/33',
    'Leoš Janáček\nCuarteto de cuerda nº 2, JW VII/13\nAutor sin identificar\nSegunda pieza, JW VIII/33',
    'Leoš Janáček\nCuarteto de cuerda nº 2, JW VII/13\nNotas sobre el catálogo, JW VIII/33',
  ])('no fabrica un bloque clásico con referencias repetidas o sin atribución: %s', (programText) => {
    const observed = facts({
      title: 'Diario de un desaparecido', categoryText: 'Teatro Musical de Cámara', programText,
      performers: [{ name: 'Cuarteto Seikilos' }, { name: 'Ensemble del Ballet del Teatro Nacional de Brno' }],
    });
    const deterministic = resolveEligibility(observed);
    expect(deterministic.value).not.toBe('include');
    expect(evaluateEligibilityAi(observed, { eligibility: 'include', evidence: [programText] }, deterministic).accepted).toBe(false);
  });

  it('no excluye el ciclo de Janáček por el ensemble del ballet', () => {
    expect(janacek.originalDecision).toEqual({ value: 'exclude', ruleId: 'dance-spectacle' });
    expect(janacek.observed.categoryText).toBe('Teatro Musical de Cámara');
    expect(janacek.observed.performers).toContainEqual({ name: 'Ensemble del Ballet del Teatro Nacional de Brno' });
    expect(janacek.observed.performers).toContainEqual({ name: 'Cuarteto Seikilos' });
    expect(janacek.observed.programText).toContain('JW VII/13');
    expect(janacek.observed.composers).toEqual([]);
    expect(janacek.observed.works).toEqual([]);
    expect(resolveEligibility(janacek.observed)).toMatchObject({
      value: 'include', ruleId: 'mixed-program-classical-block',
    });
  });

  it('un ballet principal sigue excluido aunque haya cuarteto y obras catalogadas', () => {
    expect(resolveEligibility(facts({
      title: 'Gala de ballet',
      categoryText: 'Danza',
      performers: [
        { name: 'Cuarteto Seikilos' },
        { name: 'Compañía Nacional de Ballet' },
      ],
      programText: 'Piotr Ilich Chaikovski: El lago de los cisnes, op. 20. Igor Stravinski: El pájaro de fuego, op. 4.',
    }))).toMatchObject({ value: 'exclude', ruleId: 'dance-spectacle' });
  });

  it('una compañía de ballet sin intérprete musical no se publica por el compositor citado', () => {
    const withoutQuartet = {
      ...janacek.observed,
      performers: janacek.observed.performers.filter((person) => person.name !== 'Cuarteto Seikilos'),
    };
    expect(resolveEligibility(withoutQuartet)).toMatchObject({
      value: 'exclude', ruleId: 'dance-spectacle',
    });
  });

  it('un solo número de catálogo con danza en el reparto no es un bloque', () => {
    const oneWork = facts({
      title: 'Diario de un desaparecido',
      categoryText: 'Teatro Musical de Cámara',
      performers: [
        { name: 'Cuarteto Seikilos' },
        { name: 'Ensemble del Ballet del Teatro Nacional de Brno' },
      ],
      programText: 'Leoš Janáček: Cuarteto de cuerda nº 2, JW VII/13.',
    });
    const deterministic = resolveEligibility(oneWork);
    expect(deterministic).toMatchObject({
      value: 'uncertain', ruleId: 'classical-and-nonclassical-coprincipal',
    });
    expect(evaluateEligibilityAi(oneWork, {
      eligibility: 'include',
      evidence: ['Leoš Janáček: Cuarteto de cuerda nº 2, JW VII/13.'],
    }, deterministic)).toMatchObject({
      accepted: false, ruleId: 'ai-coprincipal-without-classical-block',
    });
  });
});

describe('run 43056214891: primera parte clásica con la grafía Rachmaninov.-', () => {
  const cofares = run43056214891.find((row) => row.sourceUrl.endsWith('xxxi-concierto-navidad'))!;

  it('incluye el concierto para piano y no la segunda parte popular', () => {
    expect(cofares.originalDecision).toEqual({
      value: 'uncertain', ruleId: 'ai-coprincipal-without-classical-block',
    });
    expect(cofares.observed.composers).toEqual([]);
    expect(cofares.observed.works).toEqual([]);
    expect(cofares.observed.performers).toEqual([]);
    expect(cofares.observed.programText).toContain('Piano Rachmaninov.- Concierto para piano núm 3');
    expect(cofares.observed.programText).toContain('ABBA');
    expect(findKnownComposersInText(cofares.observed.programText ?? '')
      .map((item) => item.canonicalName)).toEqual(['Serguéi Rajmáninov']);
    expect(resolveEligibility(cofares.observed)).toMatchObject({
      value: 'include', ruleId: 'mixed-program-classical-block',
    });
  });

  it('no lee Piano Rachmaninov como compositor si no sigue una obra de concierto', () => {
    expect(findKnownComposersInText('Nicolas Varela, Piano Rachmaninov')).toEqual([]);
    expect(findKnownComposersInText('Ana Rachmaninov.- Concierto para piano núm 3')).toEqual([]);
    expect(findKnownComposersInText('Nicolas Varela, Piano Rachmaninov.- Concierto para piano núm 3')
      .map((item) => item.canonicalName)).toEqual(['Serguéi Rajmáninov']);
  });

  it('un tributo popular con cita o arreglo clásico sigue fuera', () => {
    for (const programText of [
      'ABBA: Dancing Queen. Queen: Bohemian Rhapsody. Arreglo de Rachmaninov.',
      'ABBA: Dancing Queen. Piano Rachmaninov.',
      'Canciones del Great American Songbook. Rachmaninov.- Concierto para piano núm 3.',
    ]) {
      expect(resolveEligibility(facts({
        title: 'Tributo pop',
        programText,
        performers: [{ name: 'Orquesta Clásica Santa Cecilia', roleText: 'orquesta' }],
      })), programText).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    }
  });

  it('mantiene songbook, jazz, flamenco y la evidencia insuficiente', () => {
    expect(resolveEligibility(facts({
      title: 'The Art of Love',
      description: 'Canciones del Great American Songbook.',
      composers: [{ name: 'George Gershwin' }, { name: 'Kurt Weill' }],
    }))).toMatchObject({ value: 'exclude', ruleId: 'popular-music-identity' });
    expect(resolveEligibility(facts({
      title: 'Noche de jazz',
      programText: 'Johann Sebastian Bach: Suite BWV 1007. Ludwig van Beethoven: Sonata op. 27.',
    }))).toMatchObject({ value: 'exclude', ruleId: 'jazz-identity' });
    expect(resolveEligibility(facts({
      title: 'Gala de jóvenes flamencos',
      programText: 'Johann Sebastian Bach: Suite BWV 1007. Manuel de Falla: El amor brujo, op. 2.',
    }))).toMatchObject({ value: 'exclude', ruleId: 'flamenco-identity' });
    expect(resolveEligibility(facts({ title: 'Concierto de Navidad' }))).toMatchObject({
      value: 'uncertain', ruleId: 'insufficient-evidence',
    });
  });
});
