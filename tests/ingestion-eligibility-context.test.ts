import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { resolveEligibility } from '../src/ingestion/classification/eligibility.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { evaluateEligibilityAi } from '../src/ingestion/classification/eligibility-grounding.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

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
    if (/lucia-iglesias|donde-nace-la-voz/.test(row.sourceUrl) || row.observed.title === 'Todo Chapí') {
      expect(result.value).toBe('include');
    } else {
      expect(result.value).toBe('uncertain');
    }
  });

  it('documenta el límite de reconocimiento de Cofares y aísla la corrección de mixtos', () => {
    const original = originals.find((row) => row.sourceUrl.endsWith('xxxi-concierto-navidad'))!.observed;
    expect(original.composers).toEqual([]);
    expect(original.programText).toContain('Piano Rachmaninov.- Concierto para piano núm 3');
    expect(resolveEligibility(original)).toMatchObject({
      value: 'uncertain', ruleId: 'classical-and-nonclassical-coprincipal',
    });
    // Diagnostic variant: the observed composer is structured, not a curated catalogue input.
    expect(resolveEligibility({ ...original, composers: [{ name: 'Rachmaninov' }] })).toMatchObject({
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
