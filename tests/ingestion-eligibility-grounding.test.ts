import { describe, expect, it } from 'vitest';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { parseAiClassification } from '../src/ingestion/classification/ai.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import {
  AI_AMBIGUOUS_CONTEMPORARY_RULE_ID,
  AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID,
  AI_UNGROUNDED_EVIDENCE_RULE_ID,
  evaluateEligibilityAi,
  evidenceSpanIsGrounded,
  isEditorialAiUncertain,
} from '../src/ingestion/classification/eligibility-grounding.ts';
import { CLASSICAL_AND_NONCLASSICAL_COPRINCIPAL_RULE_ID } from '../src/ingestion/classification/eligibility.ts';
import { isTechnicalClassificationFailure } from '../src/ingestion/classification/types.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return {
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function countingAi(
  inner: AiClassifier,
): AiClassifier & { calls: number } {
  const spy: AiClassifier & { calls: number } = {
    calls: 0,
    async classify(observed, context) {
      spy.calls += 1;
      return inner.classify(observed, context);
    },
  };
  return spy;
}

const spokenWordFacts = facts({
  title: 'Juan Echanove | Dir.: Enrico Amerio',
  description:
    'Un actor recorre textos de la Generación del 27. Juan Echanove, actor. Manuel Gómez Ruiz, barítono. Rubén Fernández Aguirre, piano.',
  performers: [
    { name: 'Juan Echanove', roleText: 'actor' },
    { name: 'Manuel Gómez Ruiz', roleText: 'barítono' },
    { name: 'Rubén Fernández Aguirre', roleText: 'piano' },
  ],
});

const baroqueFlamencoFacts = facts({
  title: 'Sarao Barroco',
  description:
    'En Sarao barroco, Andreas Prittwitz y el ensamble Lookingback nos invitan a descubrir el pulso festivo del Barroco y el flamenco. Cante: Eva Durán. Guitarra flamenca: José Almarcha. Guitarra barroca y archilaúd: Ramiro Morales.',
  performers: [
    { name: 'Eva Durán', roleText: 'cante' },
    { name: 'José Almarcha', roleText: 'guitarra flamenca' },
    { name: 'Ramiro Morales', roleText: 'guitarra barroca' },
  ],
});

const electronicFacts = facts({
  title: 'Sesión de conciertos: electrónica y artes visuales',
  description:
    'Programa de electrónica, electroacústica, síntesis modular, música experimental y propuestas audiovisuales.',
});

const resolvableChamberFacts = facts({
  title: 'Velada de cámara',
  description: 'El cuarteto ofrece un programa de música de cámara del clasicismo vienés.',
});

const resolvablePopularFacts = facts({
  title: 'Velada musical',
  description: 'Noche de rumba urbana y canción popular contemporánea.',
});

describe('eligibility evidence grounding', () => {
  it('rechaza una paráfrasis que no aparece en los hechos observados', () => {
    expect(
      evidenceSpanIsGrounded(spokenWordFacts, 'repertorio lírico y canción académica'),
    ).toBe(false);
    expect(evidenceSpanIsGrounded(spokenWordFacts, 'Manuel Gómez Ruiz, barítono')).toBe(true);
    expect(evidenceSpanIsGrounded(spokenWordFacts, 'barítono')).toBe(true);
  });

  it('normaliza espacios y Unicode triviales, no el orden ni el sentido', () => {
    expect(evidenceSpanIsGrounded(spokenWordFacts, '  Juan   Echanove  ')).toBe(true);
    expect(evidenceSpanIsGrounded(spokenWordFacts, 'BARÍTONO')).toBe(true);
    expect(evidenceSpanIsGrounded(spokenWordFacts, 'actor recorre textos')).toBe(true);
    expect(evidenceSpanIsGrounded(spokenWordFacts, 'textos recorre actor')).toBe(false);
  });

  it('no usa venue ni organizer como atajo editorial', () => {
    const withInstitution = facts({
      title: 'Velada',
      venueText: 'Teatro Real',
      organizerText: 'Orquesta Nacional de España',
      description: 'Encuentro con el público.',
    });
    expect(evidenceSpanIsGrounded(withInstitution, 'Teatro Real')).toBe(false);
    expect(evidenceSpanIsGrounded(withInstitution, 'Orquesta Nacional de España')).toBe(false);
    expect(evidenceSpanIsGrounded(withInstitution, 'Encuentro con el público')).toBe(true);
  });
});

describe('evaluateEligibilityAi', () => {
  it('uncertain válido no exige evidence ni la verifica', () => {
    const gated = evaluateEligibilityAi(
      spokenWordFacts,
      {
        eligibility: 'uncertain',
        evidence: [],
        rationale: 'no hay repertorio lírico suficiente en los hechos',
      },
      { ruleId: 'insufficient-evidence' },
    );
    expect(gated.accepted).toBe(true);
    expect(gated.ruleId).toBe('ai-uncertain');
    expect(gated.eligibility).toBe('uncertain');
  });

  it('include/exclude sin evidence se rechaza como ungrounded, no como JSON inválido', () => {
    const gated = evaluateEligibilityAi(
      spokenWordFacts,
      { eligibility: 'include', evidence: [] },
      { ruleId: 'insufficient-evidence' },
    );
    expect(gated.accepted).toBe(false);
    expect(gated.ruleId).toBe(AI_UNGROUNDED_EVIDENCE_RULE_ID);
    expect(isTechnicalClassificationFailure(gated.ruleId)).toBe(false);
    expect(isEditorialAiUncertain(gated.ruleId)).toBe(true);
  });

  it('no trata rationale como evidence', () => {
    const parsed = parseAiClassification({
      eligibility: 'include',
      evidence: ['repertorio lírico y canción académica'],
      rationale: 'Manuel Gómez Ruiz, barítono. Rubén Fernández Aguirre, piano.',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.evidence).toEqual(['repertorio lírico y canción académica']);
    expect(parsed.value).not.toHaveProperty('rationale');
    const gated = evaluateEligibilityAi(spokenWordFacts, parsed.value, {
      ruleId: 'insufficient-evidence',
    });
    expect(gated.accepted).toBe(false);
    expect(gated.ruleId).toBe(AI_UNGROUNDED_EVIDENCE_RULE_ID);
  });
});

describe('classifyObserved — guardrails de eligibility AI', () => {
  it('no convierte en include un repertorio lírico inventado', async () => {
    expect(classify(spokenWordFacts).eligibility.value).toBe('uncertain');
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['recital'],
          evidence: ['repertorio lírico y canción académica'],
          rationale: 'Hay barítono y piano, luego es canción académica.',
        };
      },
    });
    const result = await classifyObserved(spokenWordFacts, { ai });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe(AI_UNGROUNDED_EVIDENCE_RULE_ID);
    expect(result.eligibility.method).toBe('ai');
    expect(ai.calls).toBe(1);
    expect(isTechnicalClassificationFailure(result.eligibility.ruleId)).toBe(false);
  });

  it('no deja que la IA invente el bloque clásico de un mixto coprincipal', async () => {
    const deterministic = classify(baroqueFlamencoFacts);
    expect(deterministic.eligibility.value).toBe('uncertain');
    expect(deterministic.eligibility.ruleId).toBe(CLASSICAL_AND_NONCLASSICAL_COPRINCIPAL_RULE_ID);

    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['early-music'],
          evidence: ['Barroco', 'flamenco'],
          rationale: 'El barroco es un bloque clásico autónomo.',
        };
      },
    });
    const result = await classifyObserved(baroqueFlamencoFacts, { ai });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe(AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID);
    expect(ai.calls).toBe(1);
  });

  it('tampoco convierte esa coprincipalidad en exclude', async () => {
    const result = await classifyObserved(baroqueFlamencoFacts, {
      ai: {
        async classify() {
          return { eligibility: 'exclude', evidence: ['flamenco'] };
        },
      },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe(AI_COPRINCIPAL_WITHOUT_CLASSICAL_BLOCK_RULE_ID);
  });

  it('no convierte electrónica/electroacústica/experimental en include sin ancla clásica', async () => {
    expect(classify(electronicFacts).eligibility.value).toBe('uncertain');
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['other'],
          evidence: ['electroacústica', 'música experimental'],
          rationale: 'La electroacústica es música académica contemporánea.',
        };
      },
    });
    const result = await classifyObserved(electronicFacts, { ai });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe(AI_AMBIGUOUS_CONTEMPORARY_RULE_ID);
    expect(ai.calls).toBe(1);
  });

  it('no excluye automáticamente un concierto electroacústico con ancla académica observada', async () => {
    const academic = facts({
      title: 'Concierto de música electroacústica',
      categoryText: 'música contemporánea',
      description: 'El ensemble interpreta nuevas obras del repertorio contemporáneo.',
    });
    const deterministic = classify(academic);
    expect(deterministic.eligibility.value).toBe('include');
    expect(deterministic.eligibility.ruleId).toBe('academic-contemporary');
    const ai = countingAi({
      async classify(_observed, context) {
        expect(context?.purpose).toBe('taxonomy');
        return { eligibility: 'exclude', formats: ['other'], eras: [] };
      },
    });
    const result = await classifyObserved(academic, { ai });
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.method).not.toBe('ai');
    expect(result.eligibility.ruleId).toBe('academic-contemporary');
  });

  it('no deja que la IA convierta en exclude un concierto vienés con evidencia clásica observada', async () => {
    const viennese = facts({
      title: 'Pequeño concierto de Año Nuevo',
      description: 'Música y danza',
      categoryText: 'El Real Junior',
      programText:
        'Repertorio de valses, mazurkas y polkas interpretado por Solistas de la Orquesta Titular del Teatro Real. Un cuarteto de cuerdas de la Orquesta Sinfónica de Madrid introducirá al público en los ritmos de Viena. Valses, mazurkas y polkas serán los protagonistas. En Navidad, vamos a bailar como si estuviéramos en Viena.',
      composers: [{ name: 'y danza' }],
    });
    const deterministic = classify(viennese);
    expect(deterministic.eligibility.value).toBe('include');
    expect(deterministic.eligibility.ruleId).toBe('described-classical-repertoire');

    const ai = countingAi({
      async classify(_observed, context) {
        expect(context?.purpose).not.toBe('eligibility');
        return {
          eligibility: 'exclude',
          evidence: ['Música y danza', 'vamos a bailar como si estuviéramos en Viena'],
          rationale: 'Hay danza, luego no es un concierto clásico.',
        };
      },
    });
    const result = await classifyObserved(viennese, { ai });
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.method).not.toBe('ai');
    expect(result.eligibility.ruleId).toBe('described-classical-repertoire');
    expect(result.eligibility.ruleId).not.toBe('ai-exclude');
  });

  it('rechaza evidence que no aparece en los hechos observados', async () => {
    const result = await classifyObserved(resolvableChamberFacts, {
      ai: {
        async classify() {
          return {
            eligibility: 'include',
            evidence: ['sonatas de Beethoven y Schubert'],
          };
        },
      },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe(AI_UNGROUNDED_EVIDENCE_RULE_ID);
    expect(classify(resolvableChamberFacts).eligibility.value).toBe('uncertain');
  });

  it('acepta include cuando la evidence es literal y no dispara guardrails', async () => {
    expect(classify(resolvableChamberFacts).eligibility.value).toBe('uncertain');
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['chamber'],
          evidence: ['música de cámara del clasicismo vienés'],
          rationale: 'Un cuarteto con programa de clasicismo es concierto de cámara.',
        };
      },
    });
    const result = await classifyObserved(resolvableChamberFacts, { ai });
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.ruleId).toBe('ai-include');
    expect(result.eligibility.evidence).toContain('música de cámara del clasicismo vienés');
    expect(result.eligibility.evidence.join(' ')).not.toMatch(/Un cuarteto con programa/);
    expect(result.formats?.value).toEqual(['chamber']);
    expect(ai.calls).toBe(1);
  });

  it('acepta exclude grounded', async () => {
    expect(classify(resolvablePopularFacts).eligibility.value).toBe('uncertain');
    const result = await classifyObserved(resolvablePopularFacts, {
      ai: {
        async classify() {
          return {
            eligibility: 'exclude',
            evidence: ['canción popular contemporánea'],
            rationale: 'La identidad es popular, no un concierto clásico.',
          };
        },
      },
    });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('ai-exclude');
    expect(result.eligibility.evidence).toContain('canción popular contemporánea');
    expect(result.formats).toBeUndefined();
  });

  it('uncertain válido es final y no busca otra opinión', async () => {
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'uncertain',
          rationale: 'la ficha no basta para decidir',
        };
      },
    });
    const result = await classifyObserved(spokenWordFacts, { ai });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-uncertain');
    expect(ai.calls).toBe(1);
  });

  it('un include ungrounded no se confunde con malformed JSON ni dispara fallback', async () => {
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          evidence: ['repertorio que no está en la ficha'],
        };
      },
    });
    const result = await classifyObserved(resolvableChamberFacts, { ai });
    expect(result.eligibility.ruleId).toBe(AI_UNGROUNDED_EVIDENCE_RULE_ID);
    expect(result.eligibility.ruleId).not.toBe('ai-malformed-output');
    expect(result.eligibility.ruleId).not.toBe('ai-invalid-output');
    expect(result.eligibility.ruleId).not.toBe('ai-error');
    expect(ai.calls).toBe(1);
  });
});
