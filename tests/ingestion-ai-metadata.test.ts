import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AI_ACCESS_JSON_SCHEMA,
  AI_COMPOSER_EXTRACTION_JSON_SCHEMA,
  parseAiAccess,
  parseAiComposerExtraction,
  type AiClassifier,
} from '../src/ingestion/classification/ai.ts';
import { AI_MAX_OUTPUT_TOKENS_BY_PURPOSE } from '../src/ingestion/classification/ai-request.ts';
import {
  accessEvidenceAppears,
  composerAiHasUsableEvidence,
  validateAiComposerCandidates,
} from '../src/ingestion/classification/ai-metadata.ts';
import {
  AI_ACCESS_SYSTEM_PROMPT,
  AI_COMPOSER_SYSTEM_PROMPT,
  buildAiAccessUserMessage,
  buildAiComposerUserMessage,
} from '../src/ingestion/classification/ai-prompt.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved, enrichWithAiIfNeeded } from '../src/ingestion/classification/enrich.ts';
import { resolveEras } from '../src/ingestion/classification/eras.ts';
import { GeminiClassifier } from '../src/ingestion/classification/gemini.ts';
import { OpenAiClassifier } from '../src/ingestion/classification/openai.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { ENTITY_COLLECTIONS } from '../src/lib/repository/types.ts';
import type { DiscoveryBatch } from '../src/ingestion/discovery.ts';
import { runDiscoveryIngest } from '../src/ingestion/pipeline.ts';

const PROGRAMME = 'Maddalena Casulana — Morir non può il mio cuore';

function facts(overrides: Partial<ObservedFacts> = {}): ObservedFacts {
  return {
    title: 'OCNE. Sinfónico 01',
    categoryText: 'Música sinfónica',
    performers: [],
    composers: [{ name: 'Gustav Mahler' }],
    works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
    ...overrides,
  };
}

function spyAi(
  handler: AiClassifier['classify'],
): AiClassifier & { purposes: string[] } {
  const spy: AiClassifier & { purposes: string[] } = {
    purposes: [],
    async classify(observed, context) {
      spy.purposes.push(context?.purpose ?? 'eligibility');
      return handler(observed, context);
    },
  };
  return spy;
}

describe('access AI fallback', () => {
  it.each([
    ['Entrada gratuita', 'free'],
    ['Precio: 12 €', 'paid'],
  ] as const)('mantiene el determinista para %s y no llama a IA', async (accessText, expected) => {
    const ai = spyAi(async () => { throw new Error('no debe llamarse'); });
    const result = await classifyObserved(facts({ accessText }), { ai });
    expect(result.access?.value).toBe(expected);
    expect(ai.purposes).toEqual([]);
  });

  it('sin accessText conserva unknown y no gasta una llamada', async () => {
    const ai = spyAi(async () => { throw new Error('no debe llamarse'); });
    const result = await classifyObserved(facts(), { ai });
    expect(result.access?.value).toBe('unknown');
    expect(ai.purposes).toEqual([]);
  });

  it.each([
    ['La invitación no supone coste alguno.', 'free'],
    ['Acceso exclusivamente mediante abono vigente.', 'paid'],
  ] as const)('clasifica texto no resuelto como %s', async (accessText, classification) => {
    const ai = spyAi(async (_observed, context) => {
      expect(context?.purpose).toBe('access-classification');
      return { classification, evidence: accessText };
    });
    const result = await classifyObserved(facts({ accessText }), { ai });
    expect(result.access).toMatchObject({
      value: classification,
      method: 'ai',
      ruleId: `ai-access-${classification}`,
    });
    expect(ai.purposes).toEqual(['access-classification']);
  });

  it('unknown y evidencia no trazable permanecen unknown', async () => {
    const ambiguous = 'Es necesario reservar previamente.';
    const unknown = await classifyObserved(facts({ accessText: ambiguous }), {
      ai: { async classify() { return { classification: 'unknown', evidence: ambiguous }; } },
    });
    expect(unknown.access?.value).toBe('unknown');
    expect(unknown.access?.ruleId).toBe('ai-access-unknown');

    const invented = await classifyObserved(facts({ accessText: ambiguous }), {
      ai: { async classify() { return { classification: 'free', evidence: 'entrada gratuita' }; } },
    });
    expect(invented.access?.value).toBe('unknown');
    expect(invented.access?.ruleId).toBe('ai-access-invalid-evidence');
  });

  it('un fallo del provider no rompe el include ni cambia unknown', async () => {
    const result = await classifyObserved(facts({ accessText: 'Consultar condiciones de acceso.' }), {
      ai: { async classify() { throw new Error('provider caído'); } },
    });
    expect(result.eligibility.value).toBe('include');
    expect(result.access).toMatchObject({ value: 'unknown', method: 'ai', ruleId: 'ai-error' });
  });

  it('nunca sobrescribe un acceso ya conocido', async () => {
    const observed = facts({ accessText: 'Consultar condiciones de acceso.' });
    const deterministic = {
      ...classify(observed),
      access: { value: 'paid' as const, method: 'rule' as const, ruleId: 'published-paid', evidence: ['12 €'] },
    };
    const ai = spyAi(async () => ({ classification: 'free', evidence: observed.accessText! }));
    const result = await enrichWithAiIfNeeded(deterministic, observed, { ai });
    expect(result.access?.value).toBe('paid');
    expect(ai.purposes).toEqual([]);
  });
});

describe('composer AI fallback y validación determinista', () => {
  const unresolved = facts({
    title: 'Recital de piano de música clásica',
    categoryText: 'Música clásica',
    performers: [{ name: 'Solista invitada', roleText: 'piano' }],
    composers: [],
    works: [],
    programText: PROGRAMME,
  });

  function composerAi(candidates: Array<{ name: string; evidence: string }>): AiClassifier & { purposes: string[] } {
    return spyAi(async (_observed, context) => {
      if (context?.purpose === 'composer-extraction') return { candidates };
      return { eligibility: 'include', formats: ['symphonic'], eras: [] };
    });
  }

  it('no llama al purpose de compositores sin programText, sin cue, o si knowledge ya resolvió el programa', async () => {
    for (const observed of [
      facts(),
      facts({ composers: [], works: [{ title: 'Sinfonía', composerName: 'Gustav Mahler' }] }),
      facts({
        title: 'Recital de piano de música clásica',
        categoryText: 'Música clásica',
        performers: [{ name: 'Solista', roleText: 'piano' }],
        composers: [],
        works: [],
        programText: 'J. S. Bach — Variaciones Goldberg',
      }),
      facts({ composers: [], works: [], programText: undefined }),
    ]) {
      const ai = composerAi([]);
      await classifyObserved(observed, { ai });
      expect(ai.purposes).not.toContain('composer-extraction');
    }
  });

  it('no llama a IA cuando el knowledge ya cubre los compositores detectables del programa', async () => {
    const ai = composerAi([]);
    await classifyObserved(
      facts({
        title: 'Recital de piano de música clásica',
        categoryText: 'Música clásica',
        performers: [{ name: 'Solista invitada', roleText: 'piano' }],
        composers: [{ name: 'Juan del Encina' }, { name: 'Francisco Guerrero' }],
        works: [],
        programText: 'Obras de Josquin des Prez, Juan del Encina, Francisco Guerrero y Antonio de Cabezón.',
      }),
      { ai },
    );
    expect(ai.purposes).not.toContain('composer-extraction');
  });

  it('completa composers estructurados con un candidato de IA inequívoco y no borra los existentes', async () => {
    const observed = facts({
      title: 'Recital de piano de música clásica',
      categoryText: 'Música clásica',
      performers: [{ name: 'Solista invitada', roleText: 'piano' }],
      composers: [{ name: 'Gustav Mahler' }],
      works: [],
      programText: PROGRAMME,
    });
    const ai = composerAi([{ name: 'Maddalena Casulana', evidence: PROGRAMME }]);
    const result = await classifyObserved(observed, { ai });
    expect(ai.purposes).toContain('composer-extraction');
    expect(result.composers).toMatchObject({
      value: [{ name: 'Maddalena Casulana' }, { name: 'Gustav Mahler' }],
      method: 'ai',
      ruleId: 'ai-composers-completed',
    });
  });

  it('el gate de IA exige cues de programa y candidatos no resueltos por knowledge', () => {
    expect(composerAiHasUsableEvidence(facts({ composers: [], works: [], programText: PROGRAMME }))).toBe(true);
    expect(
      composerAiHasUsableEvidence(
        facts({
          composers: [{ name: 'Juan del Encina' }],
          works: [],
          programText: 'Obras de Josquin des Prez y Antonio de Cabezón.',
        }),
      ),
    ).toBe(false);
    expect(
      composerAiHasUsableEvidence(
        facts({
          composers: [{ name: 'Gustav Mahler' }],
          works: [],
          programText: PROGRAMME,
        }),
      ),
    ).toBe(true);
    expect(composerAiHasUsableEvidence(facts({ composers: [], works: [], programText: 'Concierto de temporada' }))).toBe(
      false,
    );
    expect(
      composerAiHasUsableEvidence(
        facts({
          composers: [{ name: 'Umberto Giordano' }],
          works: [],
          programText: 'Libreto de Arrigo Boito. Contemporáneo de Puccini.',
        }),
      ),
    ).toBe(false);
  });

  it('acepta solo el compositor explícito respaldado por el programa', async () => {
    const ai = composerAi([{ name: 'Maddalena Casulana', evidence: PROGRAMME }]);
    const result = await classifyObserved(unresolved, { ai });
    expect(result.composers).toMatchObject({
      value: [{ name: 'Maddalena Casulana' }],
      method: 'ai',
      ruleId: 'ai-composers-validated',
    });
    expect(ai.purposes[0]).toBe('composer-extraction');
  });

  it('rechaza nombres inventados y evidencia que no aparece', async () => {
    for (const candidates of [
      [{ name: 'Clara Schumann', evidence: PROGRAMME }],
      [{ name: 'Maddalena Casulana', evidence: 'Maddalena Casulana — obra desconocida' }],
    ]) {
      const result = await classifyObserved(unresolved, { ai: composerAi(candidates) });
      expect(result.composers?.value).toEqual([]);
      expect(result.composers?.ruleId).toBe('ai-composers-unresolved');
    }
  });

  it('rechaza al intérprete aunque el modelo lo llame compositor', async () => {
    const performerFacts = facts({
      composers: [],
      works: [],
      programText: 'Jean Rondeau — clave',
      performers: [{ name: 'Jean Rondeau', roleText: 'clave' }],
    });
    const ai = composerAi([{ name: 'Jean Rondeau', evidence: 'Jean Rondeau — clave' }]);
    const result = await classifyObserved(performerFacts, { ai });
    expect(ai.purposes).not.toContain('composer-extraction');
    expect(result.composers).toBeUndefined();
  });

  it('rechaza también roles y menciones contextuales explícitas en el propio span', () => {
    const role = validateAiComposerCandidates(
      [{ name: 'Jean Rondeau', evidence: 'Jean Rondeau — clave' }],
      facts({ composers: [], works: [], programText: 'Jean Rondeau — clave', performers: [] }),
    );
    expect(role.composers).toEqual([]);
    const homage = validateAiComposerCandidates(
      [{ name: 'Jean-Philippe Rameau', evidence: 'Homenaje a Rameau' }],
      facts({ composers: [], works: [], programText: 'Homenaje a Rameau', performers: [] }),
    );
    expect(homage.composers).toEqual([]);
  });

  it('acepta Moszkowski en una lista de repertorio y rechaza menciones no atribuidas', () => {
    const list = 'Schumann – Moszkowski – Chopin – Brahms – Beethoven – Ravel – Liszt';
    const observed = facts({
      composers: [
        { name: 'Robert Schumann' },
        { name: 'Frédéric Chopin' },
        { name: 'Johannes Brahms' },
        { name: 'Ludwig van Beethoven' },
        { name: 'Maurice Ravel' },
        { name: 'Franz Liszt' },
      ],
      works: [],
      programText: list,
    });
    expect(composerAiHasUsableEvidence(observed)).toBe(true);
    expect(validateAiComposerCandidates([{ name: 'Moszkowski', evidence: list }], observed).composers).toEqual([
      { name: 'Moszkowski' },
    ]);

    expect(
      validateAiComposerCandidates(
        [{ name: 'Arrigo Boito', evidence: 'Libreto de Arrigo Boito' }],
        facts({
          composers: [{ name: 'Amilcare Ponchielli' }],
          works: [],
          programText: 'Música de Amilcare Ponchielli. Libreto de Arrigo Boito.',
        }),
      ).composers,
    ).toEqual([]);

    expect(
      validateAiComposerCandidates(
        [{ name: 'Giacomo Puccini', evidence: 'Contemporáneo de Puccini' }],
        facts({
          composers: [{ name: 'Umberto Giordano' }],
          works: [],
          programText: 'Fedora de Umberto Giordano, contemporáneo de Puccini.',
        }),
      ).composers,
    ).toEqual([]);

    expect(
      validateAiComposerCandidates(
        [{ name: 'Robert Carl', evidence: 'ha estrenado una obra de Robert Carl en Hartford' }],
        facts({
          composers: [{ name: 'Clara Schumann' }],
          works: [],
          programText: 'Clara Schumann — Notturno. La flautista ha estrenado una obra de Robert Carl en Hartford.',
        }),
      ).composers,
    ).toEqual([]);

    expect(
      validateAiComposerCandidates(
        [{ name: 'Johann Sebastian Bach', evidence: 'Am Bach im Frühling' }],
        facts({
          composers: [{ name: 'Franz Schubert' }],
          works: [],
          programText: 'Franz Schubert — Am Bach im Frühling [Junto al arroyo en primavera], D 361',
        }),
      ).composers,
    ).toEqual([]);

    expect(
      validateAiComposerCandidates(
        [{ name: 'Johann Sebastian Bach', evidence: 'J. S. Bach — Suite' }],
        facts({ composers: [], works: [], programText: 'J. S. Bach — Suite' }),
      ).composers,
    ).toEqual([{ name: 'Johann Sebastian Bach' }]);
  });

  it('mantiene vacío ante evidencia insuficiente o fallo del provider', async () => {
    const empty = await classifyObserved(unresolved, { ai: composerAi([]) });
    expect(empty.composers?.value).toEqual([]);

    const failed = await classifyObserved(unresolved, {
      ai: { async classify() { throw new Error('provider caído'); } },
    });
    expect(failed.eligibility.value).toBe('include');
    expect(failed.composers).toMatchObject({ value: [], method: 'ai', ruleId: 'ai-error' });
  });

  it('deduplica variantes validadas por identidad canónica', async () => {
    const result = await classifyObserved(unresolved, {
      ai: composerAi([
        { name: 'Maddalena Casulana', evidence: PROGRAMME },
        { name: 'Maddalena Casulana', evidence: 'Maddalena Casulana' },
      ]),
    });
    expect(result.composers?.value).toEqual([{ name: 'Maddalena Casulana' }]);
  });

  it('un compositor validado puede alimentar el resolver determinista de eras', () => {
    const observed = facts({
      composers: [],
      works: [],
      programText: 'J. S. Bach — Variaciones Goldberg',
    });
    const validated = validateAiComposerCandidates(
      [{ name: 'Johann Sebastian Bach', evidence: 'J. S. Bach — Variaciones Goldberg' }],
      observed,
    );
    expect(validated.composers).toEqual([{ name: 'Johann Sebastian Bach' }]);
    expect(resolveEras({ ...observed, composers: validated.composers })).toMatchObject({
      value: ['baroque'],
      method: 'knowledge',
      ruleId: 'eras-from-composers',
    });
  });

  it('un compositor extraído y conocido vuelve a resolver eras; taxonomy no las inventa', async () => {
    const casulana = facts({
      title: 'Recital de piano de música clásica',
      categoryText: 'Música clásica',
      performers: [{ name: 'Solista invitada', roleText: 'piano' }],
      composers: [],
      works: [],
      programText: PROGRAMME,
    });
    const ai = composerAi([{ name: 'Maddalena Casulana', evidence: PROGRAMME }]);
    const unknown = await classifyObserved(casulana, { ai });
    expect(ai.purposes[0]).toBe('composer-extraction');
    expect(unknown.composers?.value).toEqual([{ name: 'Maddalena Casulana' }]);
    expect(unknown.eras?.value).toEqual([]);
    expect(unknown.eras?.method).not.toBe('ai');

    const bachProgramme = 'Obras de compositor: Johann Sebastian Bach — Variaciones Goldberg';
    const bachObserved = facts({
      title: 'Recital de piano de música clásica',
      categoryText: 'Música clásica',
      performers: [{ name: 'Solista invitada', roleText: 'piano' }],
      composers: [],
      works: [],
      programText: bachProgramme,
    });
    const withBach = await classifyObserved(bachObserved, {
      ai: composerAi([{
        name: 'Johann Sebastian Bach',
        evidence: 'Johann Sebastian Bach — Variaciones Goldberg',
      }]),
    });
    expect(withBach.eras).toMatchObject({ value: ['baroque'], method: 'knowledge' });
    expect(withBach.eras?.ruleId).not.toBe('ai-eras');
  });
});

describe('contratos y prompts de metadata AI', () => {
  it('usa schemas pequeños y estrictos', () => {
    expect(AI_ACCESS_JSON_SCHEMA.required).toEqual(['classification', 'evidence']);
    expect(AI_COMPOSER_EXTRACTION_JSON_SCHEMA.required).toEqual(['candidates']);
    expect(parseAiAccess({ classification: 'free', evidence: 'sin coste' }).ok).toBe(true);
    expect(parseAiAccess({ classification: 'free', evidence: 'sin coste', extra: true }).ok).toBe(false);
    expect(parseAiComposerExtraction({ candidates: [] }).ok).toBe(true);
    expect(parseAiComposerExtraction({ candidates: [{ name: 'Bach' }] }).ok).toBe(false);
  });

  it('el prompt de access no expone venue/source y el de composers omite campos no musicales', () => {
    const observed = facts({
      venueText: 'Teatro Real',
      organizerText: 'Fundación X',
      accessText: 'Consultar condiciones de acceso.',
      programText: PROGRAMME,
    });
    const access = buildAiAccessUserMessage(observed);
    expect(access).toContain(observed.accessText);
    expect(access).not.toContain('Teatro Real');
    expect(access).not.toContain('Fundación X');
    const composers = buildAiComposerUserMessage(observed);
    expect(composers).toContain(PROGRAMME);
    expect(composers).not.toContain('Teatro Real');
    expect(composers).not.toContain('Fundación X');
    expect(AI_ACCESS_SYSTEM_PROMPT).toMatch(/usa únicamente accessText/);
    expect(AI_ACCESS_SYSTEM_PROMPT).toMatch(/No copies accessText entero/);
    expect(AI_COMPOSER_SYSTEM_PROMPT).toMatch(/no inventar hechos ausentes/);
    expect(AI_COMPOSER_SYSTEM_PROMPT).toMatch(/no copies el programa entero/);
    expect(accessEvidenceAppears(observed.accessText!, 'condiciones de acceso')).toBe(true);
  });

  it('Gemini recibe el schema estricto de access y solo su texto observado', async () => {
    const observed = facts({
      venueText: 'Teatro Real',
      accessText: 'La invitación no supone coste alguno.',
    });
    const provider = new GeminiClassifier({
      apiKey: 'gemini-test',
      model: 'gemini-3.1-flash-lite',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.system_instruction).toBe(AI_ACCESS_SYSTEM_PROMPT);
        expect(body.input).toContain(observed.accessText);
        expect(body.input).not.toContain('Teatro Real');
        expect(body.response_format.schema).toEqual(AI_ACCESS_JSON_SCHEMA);
        expect(body.generation_config.max_output_tokens).toBe(
          AI_MAX_OUTPUT_TOKENS_BY_PURPOSE['access-classification'],
        );
        return new Response(JSON.stringify({
          steps: [{
            type: 'model_output',
            content: [{
              type: 'text',
              text: JSON.stringify({ classification: 'free', evidence: observed.accessText }),
            }],
          }],
        }));
      },
    });
    await expect(provider.classify(observed, { purpose: 'access-classification' })).resolves.toEqual({
      classification: 'free',
      evidence: observed.accessText,
    });
  });

  it('OpenAI reutiliza la misma abstracción para composer-extraction', async () => {
    const observed = facts({
      venueText: 'Teatro Real',
      composers: [],
      works: [],
      programText: PROGRAMME,
    });
    const provider = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content).toBe(AI_COMPOSER_SYSTEM_PROMPT);
        expect(body.messages[1].content).toContain(PROGRAMME);
        expect(body.messages[1].content).not.toContain('Teatro Real');
        expect(body.max_tokens).toBe(AI_MAX_OUTPUT_TOKENS_BY_PURPOSE['composer-extraction']);
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                candidates: [{ name: 'Maddalena Casulana', evidence: PROGRAMME }],
              }),
            },
          }],
        }));
      },
    });
    await expect(provider.classify(observed, { purpose: 'composer-extraction' })).resolves.toEqual({
      candidates: [{ name: 'Maddalena Casulana', evidence: PROGRAMME }],
    });
  });
});

describe('pipeline y budget compartido', () => {
  it('publica los metadatos validados y contabiliza cada purpose en el mismo classifier', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clasica-ai-metadata-'));
    for (const collection of ENTITY_COLLECTIONS) {
      await mkdir(path.join(dataDir, collection), { recursive: true });
    }
    const batch: DiscoveryBatch = {
      schemaVersion: 1,
      observations: [{
        source: {
          url: 'https://example.org/conciertos/casulana',
          homepage: 'https://example.org/',
          name: 'Ciclo de prueba',
          kind: 'official',
        },
        venue: {
          name: 'Sala de prueba',
          municipality: 'Madrid',
          area: 'madrid',
          address: 'Calle de Alcalá, 1, Madrid',
        },
        event: {
          title: 'Recital de piano de música clásica',
          categoryText: 'Música clásica',
          venueText: 'Sala de prueba',
          occurrences: [{ raw: '2026-10-12 19:30', date: '2026-10-12', time: '19:30' }],
          programText: PROGRAMME,
          accessText: 'La invitación no supone coste alguno.',
          performers: [{ name: 'Solista invitada', roleText: 'piano' }],
          composers: [],
          works: [],
        },
      }],
    };
    const ai = spyAi(async (_observed, context) => {
      if (context?.purpose === 'composer-extraction') {
        return { candidates: [{ name: 'Maddalena Casulana', evidence: PROGRAMME }] };
      }
      if (context?.purpose === 'access-classification') {
        return { classification: 'free', evidence: 'La invitación no supone coste alguno.' };
      }
      if (context?.purpose === 'taxonomy') {
        return { formats: ['recital'], eras: ['renaissance'], evidence: ['Maddalena Casulana'] };
      }
      throw new Error(`purpose inesperado: ${context?.purpose}`);
    });
    const run = await runDiscoveryIngest({
      dataDir,
      catalog: emptyCatalog(),
      now: new Date('2026-09-08T12:00:00Z'),
      dryRun: true,
      batch,
      ai,
    });

    expect(run.candidates).toHaveLength(1);
    expect(run.candidates[0]!.event.composers).toEqual([{ name: 'Maddalena Casulana' }]);
    expect(run.candidates[0]!.event.access).toBe('free');
    expect(run.candidates[0]!.event.eras).toEqual(['renaissance']);
    expect(ai.purposes).toEqual(['access-classification', 'taxonomy']);
    expect(run.summary.ai.attempted).toBe(2);
    expect(run.summary.ai.byPurpose['composer-extraction']).toMatchObject({ attempted: 0 });
    expect(run.summary.ai.byPurpose['access-classification']).toMatchObject({ attempted: 1, resolved: 1 });
    expect(run.summary.ai.byPurpose.taxonomy).toMatchObject({ attempted: 1, resolved: 1 });
    expect(run.summary.quality).toMatchObject({
      composers: { populated: 1, unresolved: 0 },
      eras: { populated: 1, unresolved: 0 },
      formats: { populated: 1, unresolved: 0 },
      access: { free: 1, paid: 0, unresolved: 0 },
    });
  });
});
