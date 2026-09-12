import { describe, expect, it } from 'vitest';
import {
  AI_ACCESS_JSON_SCHEMA,
  AI_CALL_PURPOSES,
  AI_COMPOSER_EXTRACTION_JSON_SCHEMA,
  AI_ELIGIBILITY_JSON_SCHEMA,
  AI_EVIDENCE_MAX_ITEMS,
  AI_TAXONOMY_JSON_SCHEMA,
  aiJsonSchemaForPurpose,
  parseAiEligibility,
  parseAiTaxonomy,
  type AiCallPurpose,
} from '../src/ingestion/classification/ai.ts';
import {
  ACCESS_INPUT_FIELDS,
  COMPOSER_INPUT_FIELDS,
  ELIGIBILITY_INPUT_FIELDS,
  EXCLUDED_ELIGIBILITY_FIELDS,
  compactJson,
  projectObservedForPurpose,
} from '../src/ingestion/classification/ai-input.ts';
import {
  AI_CLASSIFIER_PROMPT_VERSION,
  AI_TAXONOMY_PROMPT_VERSION,
  AI_ACCESS_SYSTEM_PROMPT,
  AI_CLASSIFIER_SYSTEM_PROMPT,
  AI_COMPOSER_SYSTEM_PROMPT,
  AI_TAXONOMY_SYSTEM_PROMPT,
  buildAiAccessUserMessage,
  buildAiClassifierUserMessage,
  buildAiComposerUserMessage,
  buildAiTaxonomyUserMessage,
} from '../src/ingestion/classification/ai-prompt.ts';
import { AI_REQUEST_CONTRACT_VERSION, buildAiRequest } from '../src/ingestion/classification/ai-request.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved } from '../src/ingestion/classification/enrich.ts';
import { resolveFormats } from '../src/ingestion/classification/formats.ts';
import { resolveEras } from '../src/ingestion/classification/eras.ts';
import { resolveAccess } from '../src/ingestion/classification/access.ts';
import { evaluateEligibilityAi } from '../src/ingestion/classification/eligibility-grounding.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return { performers: [], composers: [], works: [], ...overrides };
}

function countingAi(
  inner: AiClassifier,
): AiClassifier & { calls: number; purposes: Array<string | undefined> } {
  const spy: AiClassifier & { calls: number; purposes: Array<string | undefined> } = {
    calls: 0,
    purposes: [],
    async classify(observed, context) {
      spy.calls += 1;
      spy.purposes.push(context?.purpose);
      return inner.classify(observed, context);
    },
  };
  return spy;
}

const strongInclude = facts({
  title: 'OCNE. Sinfónico 01',
  composers: [{ name: 'Gustav Mahler' }],
  works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
});

const weakRecital = facts({
  title: 'Velada de música clásica',
  categoryText: 'Música clásica',
  description: 'Ana Pérez interpreta un programa de piano solo.',
  performers: [{ name: 'Ana Pérez', roleText: 'piano' }],
});

const unresolvedFormats = facts({
  title: 'Programa clásico',
  programText: 'Johannes Brahms',
});

const unknownComposer = facts({
  title: 'Recital de música clásica',
  categoryText: 'Música clásica',
  composers: [{ name: 'Maddalena Casulana' }],
});

const composerProgramme = facts({
  title: 'Recital de música clásica',
  categoryText: 'Música clásica',
  performers: [{ name: 'Solista invitada', roleText: 'piano' }],
  composers: [],
  works: [],
  programText: 'Maddalena Casulana — Morir non può il mio cuore',
});

describe('contratos por purpose — ningún mega-schema', () => {
  it('cada purpose tiene schema propio, additionalProperties:false y evidence ≤ 4', () => {
    expect(AI_REQUEST_CONTRACT_VERSION).toBe(4);
    expect(AI_EVIDENCE_MAX_ITEMS).toBe(4);
    expect(AI_CLASSIFIER_PROMPT_VERSION).toBe(13);
    expect(AI_TAXONOMY_PROMPT_VERSION).toBe(9);

    expect(AI_ELIGIBILITY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(AI_ELIGIBILITY_JSON_SCHEMA.required).toEqual(['eligibility', 'formats', 'evidence']);
    expect(AI_ELIGIBILITY_JSON_SCHEMA.properties).not.toHaveProperty('eras');
    expect(AI_ELIGIBILITY_JSON_SCHEMA.properties).not.toHaveProperty('kind');
    expect(AI_ELIGIBILITY_JSON_SCHEMA.properties).not.toHaveProperty('rationale');

    expect(AI_TAXONOMY_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(AI_TAXONOMY_JSON_SCHEMA.required).toEqual(['formats', 'eras', 'evidence']);
    expect(AI_TAXONOMY_JSON_SCHEMA.properties).not.toHaveProperty('eligibility');
    expect(AI_TAXONOMY_JSON_SCHEMA.properties).not.toHaveProperty('kind');
    expect(AI_TAXONOMY_JSON_SCHEMA.properties).not.toHaveProperty('rationale');

    expect(AI_ACCESS_JSON_SCHEMA.required).toEqual(['classification', 'evidence']);
    expect(AI_COMPOSER_EXTRACTION_JSON_SCHEMA.required).toEqual(['candidates']);

    expect(aiJsonSchemaForPurpose('eligibility')).toBe(AI_ELIGIBILITY_JSON_SCHEMA);
    expect(aiJsonSchemaForPurpose('taxonomy')).toBe(AI_TAXONOMY_JSON_SCHEMA);
    expect(aiJsonSchemaForPurpose('access-classification')).toBe(AI_ACCESS_JSON_SCHEMA);
    expect(aiJsonSchemaForPurpose('composer-extraction')).toBe(AI_COMPOSER_EXTRACTION_JSON_SCHEMA);
    expect(AI_CALL_PURPOSES).toEqual([
      'eligibility',
      'composer-extraction',
      'access-classification',
      'taxonomy',
    ]);
  });

  it('el parser de eligibility ignora campos legacy y no depende de ellos', () => {
    const parsed = parseAiEligibility({
      eligibility: 'include',
      formats: ['chamber', 'chamber'],
      eras: ['romantic'],
      kind: 'established',
      rationale: 'un ensayo largo',
      evidence: ['cuarteto de cuerda'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      eligibility: 'include',
      formats: ['chamber'],
      evidence: ['cuarteto de cuerda'],
    });
    expect(parsed.value).not.toHaveProperty('eras');
    expect(parsed.value).not.toHaveProperty('kind');
    expect(parsed.value).not.toHaveProperty('rationale');
  });

  it('el parser de taxonomy ignora eligibility/kind/rationale legacy', () => {
    const parsed = parseAiTaxonomy({
      eligibility: 'exclude',
      formats: ['recital'],
      eras: ['renaissance'],
      kind: 'alternative',
      rationale: 'no cuenta',
      evidence: ['Maddalena Casulana'],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      formats: ['recital'],
      eras: ['renaissance'],
      evidence: ['Maddalena Casulana'],
    });
  });

  it('JSON inválido o fuera de vocabulario no se acepta', () => {
    expect(parseAiEligibility('no es json').ok).toBe(false);
    expect(parseAiEligibility({ eligibility: 'include', formats: ['jazz'], evidence: ['x'] }).ok).toBe(false);
    expect(parseAiTaxonomy({ formats: ['jazz'], eras: [], evidence: ['x'] }).ok).toBe(false);
  });
});

describe('inputs específicos por purpose', () => {
  const observed = facts({
    title: 'Concierto extraordinario',
    description: 'Programa de repertorio de música antigua.',
    categoryText: 'Música',
    venueText: 'Teatro Real',
    organizerText: 'Orquesta Nacional de España',
    seriesText: 'Ciclo de cámara',
    accessText: 'Entrada 12 €',
    programText: 'J.S. Bach — Suites',
    performers: [{ name: 'Ana Pérez', roleText: 'piano' }],
    composers: [{ name: 'Johann Sebastian Bach' }],
    works: [{ title: 'Suites', composerName: 'Johann Sebastian Bach' }],
  });

  it('eligibility y taxonomy omiten venue, organizer y access', () => {
    for (const purpose of ['eligibility', 'taxonomy'] as const) {
      const projected = projectObservedForPurpose(observed, purpose) as Record<string, unknown>;
      expect(Object.keys(projected).sort()).toEqual([...ELIGIBILITY_INPUT_FIELDS].sort());
      for (const field of EXCLUDED_ELIGIBILITY_FIELDS) {
        expect(projected).not.toHaveProperty(field);
        expect(compactJson(projected)).not.toContain(String(observed[field]));
      }
      expect(projected.title).toBe(observed.title);
      expect(projected.programText).toBe(observed.programText);
    }
  });

  it('composer-extraction sólo envía programa, obras e intérpretes', () => {
    const projected = projectObservedForPurpose(observed, 'composer-extraction') as Record<string, unknown>;
    expect(Object.keys(projected).sort()).toEqual([...COMPOSER_INPUT_FIELDS].sort());
    expect(compactJson(projected)).not.toContain('Teatro Real');
    expect(compactJson(projected)).not.toContain('Entrada 12');
  });

  it('access-classification envía sólo accessText', () => {
    expect(projectObservedForPurpose(observed, 'access-classification')).toBe(observed.accessText);
    expect(ACCESS_INPUT_FIELDS).toEqual(['accessText']);
    const message = buildAiAccessUserMessage(observed);
    expect(message).toContain(observed.accessText);
    expect(message).not.toContain('Teatro Real');
  });

  it('omite arrays vacíos y no pretty-printa el JSON', () => {
    const sparse = facts({ title: 'Concierto', description: 'Ficha breve.' });
    const projected = projectObservedForPurpose(sparse, 'eligibility') as Record<string, unknown>;
    expect(projected).not.toHaveProperty('performers');
    expect(projected).not.toHaveProperty('composers');
    expect(projected).not.toHaveProperty('works');
    expect(projected).not.toHaveProperty('programText');
    const user = buildAiClassifierUserMessage(sparse);
    expect(user).toContain(compactJson(projected));
    expect(user).not.toMatch(/\n {2}"title"/);
  });
});

describe('1. strong deterministic no necesita IA', () => {
  it('include con format y era fuertes no llama a IA', async () => {
    const ai = countingAi({
      classify: async () => {
        throw new Error('IA no debe llamarse');
      },
    });
    const result = await classifyObserved(strongInclude, { ai });
    expect(classify(strongInclude).eligibility.value).toBe('include');
    expect(resolveFormats(strongInclude)).toMatchObject({ value: ['symphonic'], strength: 'strong' });
    expect(resolveEras(strongInclude)).toMatchObject({ value: ['romantic'], strength: 'strong' });
    expect(result.eligibility.method).not.toBe('ai');
    expect(ai.calls).toBe(0);
  });

  it('entrada libre es access strong y no llama a IA', async () => {
    const ai = countingAi({
      classify: async () => {
        throw new Error('IA no debe llamarse');
      },
    });
    const observed = facts({ ...strongInclude, accessText: 'Entrada libre' });
    expect(resolveAccess(observed.accessText)).toMatchObject({ value: 'free', strength: 'strong' });
    const result = await classifyObserved(observed, { ai });
    expect(result.access?.value).toBe('free');
    expect(ai.calls).toBe(0);
  });
});

describe('2. weak deterministic format puede ser corregido por IA', () => {
  it('un recital inferido por rol de piano cede a chamber con evidencia', async () => {
    expect(classify(weakRecital).eligibility.value).toBe('include');
    expect(resolveFormats(weakRecital)).toMatchObject({ value: ['recital'], strength: 'weak' });

    const ai = countingAi({
      async classify(_observed, context) {
        expect(context?.purpose).toBe('taxonomy');
        return {
          formats: ['chamber'],
          eras: [],
          evidence: ['programa de piano solo'],
        };
      },
    });
    const result = await classifyObserved(weakRecital, { ai });
    expect(result.formats?.value).toEqual(['chamber']);
    expect(result.formats?.method).toBe('ai');
    expect(result.eligibility.method).not.toBe('ai');
    expect(ai.calls).toBe(1);
  });
});

describe('3. unresolved format puede ser resuelto por IA', () => {
  it('formats vacíos reciben chamber de taxonomy', async () => {
    expect(resolveFormats(unresolvedFormats).strength).toBe('unresolved');
    const ai = countingAi({
      async classify() {
        return { formats: ['chamber'], eras: [], evidence: ['Johannes Brahms'] };
      },
    });
    const result = await classifyObserved(unresolvedFormats, { ai });
    expect(result.formats?.value).toEqual(['chamber']);
    expect(result.formats?.method).toBe('ai');
    expect(result.eras?.value).toEqual(['romantic']);
  });
});

describe('4. compositor extraído por IA queda respaldado por evidence', () => {
  it('acepta el candidato cuyo span aparece en el programa', async () => {
    const ai = countingAi({
      async classify(_observed, context) {
        if (context?.purpose === 'composer-extraction') {
          return {
            candidates: [{ name: 'Maddalena Casulana', evidence: 'Maddalena Casulana — Morir non può il mio cuore' }],
          };
        }
        return { formats: ['recital'], eras: ['renaissance'], evidence: ['Maddalena Casulana'] };
      },
    });
    const result = await classifyObserved(composerProgramme, { ai });
    expect(result.composers?.value).toEqual([{ name: 'Maddalena Casulana' }]);
    expect(result.composers?.evidence.some((item) => item.includes('Maddalena Casulana'))).toBe(true);
    expect(ai.purposes).toContain('composer-extraction');
  });
});

describe('5. compositor conocido deriva era determinísticamente', () => {
  it('Bach → baroque sin IA', async () => {
    const observed = facts({
      title: 'Recital de música clásica',
      categoryText: 'Música clásica',
      composers: [{ name: 'Johann Sebastian Bach' }],
    });
    const ai = countingAi({
      classify: async () => {
        throw new Error('IA no debe llamarse');
      },
    });
    const result = await classifyObserved(observed, { ai });
    expect(result.eras).toMatchObject({ value: ['baroque'], method: 'knowledge', strength: 'strong' });
    expect(ai.calls).toBe(0);
  });
});

describe('6. compositor desconocido puede obtener era mediante IA', () => {
  it('Casulana observada recibe renaissance de taxonomy', async () => {
    expect(resolveEras(unknownComposer).value).toEqual([]);
    const ai = countingAi({
      async classify() {
        return { formats: ['recital'], eras: ['renaissance'], evidence: ['Maddalena Casulana'] };
      },
    });
    const result = await classifyObserved(unknownComposer, { ai });
    expect(result.eras?.value).toEqual(['renaissance']);
    expect(result.eras?.method).toBe('ai');
    expect(ai.purposes).toEqual(['taxonomy']);
  });
});

describe('7. era AI no sobrescribe una era determinista fuerte', () => {
  it('Bach se conserva aunque taxonomy devuelva romantic', async () => {
    const observed = facts({
      title: 'Programa clásico',
      programText: 'Johannes Brahms',
    });
    const ai = countingAi({
      async classify() {
        return { formats: ['chamber'], eras: ['contemporary'], evidence: ['Johannes Brahms'] };
      },
    });
    const result = await classifyObserved(observed, { ai });
    expect(result.eras).toMatchObject({ value: ['romantic'], method: 'knowledge' });
    expect(result.formats?.value).toEqual(['chamber']);
  });
});

describe('8. eligibility AI sigue pasando por grounding', () => {
  it('un include con span no observado queda uncertain', async () => {
    const observed = facts({
      title: 'Velada',
      venueText: 'Teatro Real',
      description: 'Encuentro con el público.',
    });
    const ai = countingAi({
      async classify() {
        return { eligibility: 'include', formats: ['recital'], evidence: ['Teatro Real'] };
      },
    });
    const result = await classifyObserved(observed, { ai });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-ungrounded-evidence');
    const gated = evaluateEligibilityAi(
      observed,
      { eligibility: 'include', evidence: ['Teatro Real'] },
      { ruleId: 'insufficient-evidence' },
    );
    expect(gated.accepted).toBe(false);
  });
});

describe('9. inputs enviados al request coinciden con la proyección', () => {
  it('buildAiRequest no serializa campos irrelevantes', () => {
    const observed = facts({
      title: 'Concierto',
      venueText: 'Teatro Real',
      organizerText: 'Ayuntamiento',
      accessText: '12 €',
      description: 'Música de cámara.',
    });
    for (const purpose of ['eligibility', 'taxonomy'] as const satisfies AiCallPurpose[]) {
      const request = buildAiRequest(observed, purpose);
      expect(request.contractVersion).toBe(4);
      expect(request.user).not.toContain('Teatro Real');
      expect(request.user).not.toContain('Ayuntamiento');
      expect(request.user).not.toContain('12 €');
      expect(request.schema).toBe(aiJsonSchemaForPurpose(purpose));
    }
    expect(buildAiRequest(observed, 'access-classification').user).toContain('12 €');
    expect(buildAiRequest(observed, 'access-classification').user).not.toContain('Teatro Real');
  });
});

describe('10. prompts ya no describen el mega-schema', () => {
  it('eligibility no pide eras, kind ni rationale', () => {
    expect(AI_CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/"eras"/);
    expect(AI_CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/"kind"/);
    expect(AI_CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/"rationale"/);
    expect(AI_CLASSIFIER_SYSTEM_PROMPT).toMatch(/No pidas ni devuelvas eras, kind ni rationale/);
    expect(AI_TAXONOMY_SYSTEM_PROMPT).not.toMatch(/"eligibility"/);
    expect(AI_TAXONOMY_SYSTEM_PROMPT).not.toMatch(/NO rellenes eras/);
    expect(AI_TAXONOMY_SYSTEM_PROMPT).toMatch(/asignar formats y, si los hechos lo permiten, eras/);
    expect(AI_ACCESS_SYSTEM_PROMPT).toMatch(/El schema define la forma JSON/);
    expect(AI_COMPOSER_SYSTEM_PROMPT).toMatch(/El schema define la forma JSON/);
  });
});

describe('11. fallos o JSON inválido mantienen comportamiento conservador', () => {
  it('taxonomy inválida conserva include y formats deterministas débiles', async () => {
    const ai = countingAi({
      async classify() {
        return { formats: ['jazz'], eras: [], evidence: ['piano'] };
      },
    });
    const result = await classifyObserved(weakRecital, { ai });
    expect(result.eligibility.value).toBe('include');
    expect(result.formats?.value).toEqual(['recital']);
    expect(result.formats?.method).toBe('rule');
  });

  it('eligibility malformed conserva uncertain', async () => {
    const result = await classifyObserved(facts({ title: 'Concierto extraordinario' }), {
      ai: { async classify() { return 'esto no es JSON'; } },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-malformed-output');
  });
});

describe('user messages compactos', () => {
  it('taxonomy y composer no pretty-printan', () => {
    const observed = composerProgramme;
    expect(buildAiTaxonomyUserMessage(observed)).not.toMatch(/\n {2}"title"/);
    expect(buildAiComposerUserMessage(observed)).not.toMatch(/\n {2}"programText"/);
  });
});
