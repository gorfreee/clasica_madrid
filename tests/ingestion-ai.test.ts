import { describe, expect, it } from 'vitest';
import type { ObservedFacts } from '../src/ingestion/observed.ts';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import {
  AI_CLASSIFICATION_JSON_SCHEMA,
  AiRateLimitedError,
  parseAiClassification,
} from '../src/ingestion/classification/ai.ts';
import {
  AI_CLASSIFIER_PROMPT_VERSION,
  AI_CLASSIFIER_SYSTEM_PROMPT,
  buildAiClassifierUserMessage,
} from '../src/ingestion/classification/ai-prompt.ts';
import { classify } from '../src/ingestion/classification/classify.ts';
import { classifyObserved, enrichWithAiIfNeeded } from '../src/ingestion/classification/enrich.ts';
import {
  GeminiClassifier,
  GEMINI_API_REVISION,
  GEMINI_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODELS,
} from '../src/ingestion/classification/gemini.ts';
import type { SleepClock } from '../src/ingestion/classification/gemini.ts';
import {
  OpenAiClassifier,
  OPENAI_DEFAULT_MODEL,
} from '../src/ingestion/classification/openai.ts';
import { createAiClassifierFromEnv } from '../src/ingestion/classification/provider.ts';

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return {
    performers: [],
    composers: [],
    works: [],
    ...overrides,
  };
}

function immediateClock(): SleepClock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function countingAi(inner: AiClassifier): AiClassifier & { calls: number } {
  const spy: AiClassifier & { calls: number } = {
    calls: 0,
    async classify(observed) {
      spy.calls += 1;
      return inner.classify(observed);
    },
  };
  return spy;
}

const includeFacts = facts({
  title: 'OCNE. Sinfónico 01',
  composers: [{ name: 'Gustav Mahler' }],
  works: [{ title: 'Sinfonía núm. 2', composerName: 'Gustav Mahler' }],
});

const excludeFacts = facts({
  title: 'Jazz en el Auditorio',
  categoryText: 'Jazz en el Auditorio',
});

const uncertainFacts = facts({ title: 'Concierto extraordinario' });

describe('AI classifier prompt v2', () => {
  const prompt = AI_CLASSIFIER_SYSTEM_PROMPT;

  it('is version 5 so results are distinguishable from earlier prompts', () => {
    expect(AI_CLASSIFIER_PROMPT_VERSION).toBe(5);
  });

  it('keeps precision, uncertain as a valid output, and the ban on inventing facts', () => {
    expect(prompt).toMatch(/precisi[oó]n\s*>\s*cobertura/);
    expect(prompt).toMatch(/uncertain es una salida v[aá]lida/);
    expect(prompt).toMatch(/no inventes performers, composers, works/);
    expect(prompt).toMatch(/no uses source ni venue/);
    expect(prompt).toContain('eligibility ≠ format ≠ kind');
  });

  it('keeps decided exclusions for pop, DJ, film, jazz, flamenco, dance, cinema and workshops', () => {
    expect(prompt).toMatch(/pop\s*\/\s*rock\s*\/\s*canci[oó]n popular/);
    expect(prompt).toMatch(/DJ\s*\/\s*electr[oó]nica\s*\/\s*crossover/);
    expect(prompt).toMatch(/m[uú]sica de cine como contenido principal/);
    expect(prompt).toMatch(/jazz como identidad del evento/);
    expect(prompt).toMatch(/flamenco musical espa[nñ]ol/);
    expect(prompt).toMatch(/danza o ballet como espect[aá]culo/);
    expect(prompt).toMatch(/cine\s*\/\s*proyecci[oó]n como actividad principal/);
    expect(prompt).toMatch(/talleres, charlas, conferencias/);
  });

  it('allows contemporary/neoclassical concert music without treating popularity as exclusion', () => {
    expect(prompt).toMatch(/instrumental contempor[aá]nea o neocl[aá]sica/);
    expect(prompt).toMatch(/tradici[oó]n concert[ií]stica/);
    expect(prompt).toMatch(/popularidad o el car[aá]cter comercial no son criterio de exclusi[oó]n/);
    expect(prompt).toMatch(/m[uú]sica de cine, pop\/rock o crossover no cl[aá]sico/);
  });

  it('states mixed-event include vs exclude vs uncertain', () => {
    expect(prompt).toMatch(/Eventos mixtos/);
    expect(prompt).toMatch(/bloque cl[aá]sico sustancial, aut[oó]nomo e identificable/);
    expect(prompt).toMatch(/acompa[nñ]amiento, arreglo, ornamentaci[oó]n o formato instrumental/);
    expect(prompt).toMatch(/ABBA\/Queen\/Beatles con orquesta/);
    expect(prompt).toMatch(/Hans Zimmer\/Morricone/);
    expect(prompt).toMatch(/coprincipales/);
    expect(prompt).toMatch(/NUNCA exclude autom[aá]tico por coprincipalidad/);
    expect(prompt).toMatch(/Fito P[aá]ez con cuerdas/);
    expect(prompt).toMatch(/musical de Broadway/);
  });

  it('hardens coprincipal classical + excluded identity to uncertain without a substantial classical block', () => {
    expect(prompt).toMatch(/identidad expresamente excluida/);
    expect(prompt).toMatch(
      /include s[oó]lo si los hechos observados demuestran un bloque cl[aá]sico sustancial, aut[oó]nomo e identificable/,
    );
    expect(prompt).toMatch(/Si no lo demuestran → uncertain, no include/);
    expect(prompt).toMatch(/primera parte independiente de repertorio cl[aá]sico y segunda parte popular\/regional/);
    expect(prompt).not.toMatch(/include o, como m[ií]nimo, uncertain/);
    expect(prompt).not.toMatch(/Sarao Barroco/);
    expect(prompt).not.toMatch(/golden_sarao/);
  });

  it('does not force uncertain when a classical cycle lacks a work-by-work programme', () => {
    expect(prompt).toMatch(/obra-por-obra NO obliga a uncertain/);
    expect(prompt).toMatch(/festival o ciclo expl[ií]citamente de m[uú]sica cl[aá]sica/);
    expect(prompt).toMatch(/source conocida → include/);
    expect(prompt).toMatch(/venue cl[aá]sico → include/);
    expect(prompt).toMatch(/se excluyen individualmente/);
    expect(prompt).toMatch(/concierto de m[uú]sica cl[aá]sica/);
  });

  it('excludes participatory activities even inside a classical festival', () => {
    expect(prompt).toMatch(/open piano/);
    expect(prompt).toMatch(/piano abierto al p[uú]blico/);
    expect(prompt).toMatch(/jam participativa/);
    expect(prompt).toMatch(/instrumento a disposici[oó]n del p[uú]blico/);
    expect(prompt).toMatch(/no convierte esa actividad en concierto/);
  });

  it('distinguishes Spanish flamenco from Franco-Flemish / Chigi contexts', () => {
    expect(prompt).toMatch(/franco-flamenco/);
    expect(prompt).toMatch(/C[oó]dice de Chigi/);
    expect(prompt).toMatch(/coinciden(?:cia)? l[eé]xica/);
    expect(prompt).toMatch(/Flemish/);
    expect(prompt).toMatch(/Si el contexto no permite distinguir → uncertain/);
  });

  it('allows musical knowledge only to interpret observed facts', () => {
    expect(prompt).toMatch(/conocimiento musical general para interpretar hechos observados/);
    expect(prompt).toMatch(/Bach o un R[eé]quiem de Mozart/);
    expect(prompt).toMatch(/NO puede inventar que un compositor, obra, performer/);
  });

  it('keeps the structured JSON contract without extra fields', () => {
    expect(prompt).toContain('"eligibility": "include" | "exclude" | "uncertain"');
    expect(prompt).toContain('"formats"');
    expect(prompt).toContain('"eras"');
    expect(prompt).toContain('"kind": "established" | "alternative"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toMatch(/rationale es metadata auxiliar muy breve/);
    expect(prompt).toMatch(/m[aá]ximo 1[–-]2 frases/);
    expect(prompt).toMatch(/No repitas evidence/);
    expect(prompt).not.toMatch(/confidence/i);
    expect(prompt).not.toMatch(/chain[- ]of[- ]thought/i);
  });

  it('asks the same call to fill eras from works, composers and programText', () => {
    expect(prompt).toMatch(/si eligibility=include, intenta rellenarlas/);
    expect(prompt).toMatch(/programText cuando nombra expl[ií]citamente/);
    expect(prompt).toMatch(/Bach\/H[äa]ndel → baroque/);
    expect(prompt).toMatch(/Mozart\/Haydn → classical/);
    expect(prompt).toMatch(/Brahms\/Mahler → romantic/);
    expect(prompt).toMatch(/eras=\[\] s[oó]lo si/);
  });
});

describe('parseAiClassification', () => {
  it('acepta un objeto válido y recorta duplicados', () => {
    const parsed = parseAiClassification({
      eligibility: 'include',
      formats: ['early-music', 'chamber', 'early-music'],
      eras: ['early'],
      kind: 'established',
      evidence: ['ensemble de música antigua'],
      extra: 'se ignora',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.eligibility).toBe('include');
    expect(parsed.value.formats).toEqual(['early-music', 'chamber']);
    expect(parsed.value.eras).toEqual(['early']);
    expect(parsed.value.kind).toBe('established');
  });

  it('parsea JSON en string y rechaza prosa', () => {
    const ok = parseAiClassification('{"eligibility":"uncertain"}');
    expect(ok.ok).toBe(true);

    const malformed = parseAiClassification('no es json');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.ruleId).toBe('ai-malformed-output');
  });

  it('rechaza valores fuera de taxonomía y eligibility desconocida', () => {
    const jazz = parseAiClassification({
      eligibility: 'include',
      formats: ['jazz'],
    });
    expect(jazz.ok).toBe(false);
    if (jazz.ok) return;
    expect(jazz.ruleId).toBe('ai-invalid-output');

    const maybe = parseAiClassification({ eligibility: 'maybe' });
    expect(maybe.ok).toBe(false);
    if (maybe.ok) return;
    expect(maybe.ruleId).toBe('ai-invalid-output');
  });

  it('rechaza vacío, null y arrays', () => {
    expect(parseAiClassification('').ok).toBe(false);
    expect(parseAiClassification(null).ok).toBe(false);
    expect(parseAiClassification([]).ok).toBe(false);
  });

  it('trunca rationale > 800 y conserva una clasificación válida', () => {
    const parsed = parseAiClassification({
      eligibility: 'include',
      kind: 'alternative',
      evidence: ['ciclo de órgano'],
      rationale: `x`.repeat(801),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.eligibility).toBe('include');
    expect(parsed.value.kind).toBe('alternative');
    const rationale = parsed.value.evidence.find((item) => item.length === 800);
    expect(rationale).toBe('x'.repeat(800));
  });

  it('un output semánticamente inválido sigue siendo ai-invalid-output aunque rationale sea largo', () => {
    const parsed = parseAiClassification({
      eligibility: 'include',
      formats: ['jazz'],
      rationale: 'y'.repeat(900),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.ruleId).toBe('ai-invalid-output');
  });
});

describe('classifyObserved — no llama a IA si ya está resuelto', () => {
  it('include determinista no llama a IA y sigue include', async () => {
    const ai = countingAi({
      classify: async () => {
        throw new Error('IA no debe llamarse');
      },
    });
    const result = await classifyObserved(includeFacts, { ai });
    expect(classify(includeFacts).eligibility.value).toBe('include');
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.method).not.toBe('ai');
    expect(ai.calls).toBe(0);
  });

  it('exclude determinista no llama a IA y sigue exclude', async () => {
    const ai = countingAi({
      classify: async () => {
        throw new Error('IA no debe llamarse');
      },
    });
    const result = await classifyObserved(excludeFacts, { ai });
    expect(classify(excludeFacts).eligibility.value).toBe('exclude');
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.method).not.toBe('ai');
    expect(result.formats).toBeUndefined();
    expect(ai.calls).toBe(0);
  });
});

describe('classifyObserved — fallback cuando el determinista es uncertain', () => {
  it('AI include → include, una sola llamada', async () => {
    const ai = countingAi({
      async classify() {
        return {
          eligibility: 'include',
          formats: ['early-music'],
          kind: 'alternative',
          evidence: ['repertorio de música antigua'],
        };
      },
    });
    const result = await classifyObserved(uncertainFacts, { ai });
    expect(result.eligibility.value).toBe('include');
    expect(result.eligibility.method).toBe('ai');
    expect(result.eligibility.ruleId).toBe('ai-include');
    expect(result.formats?.value).toEqual(['early-music']);
    expect(result.kind?.value).toBe('alternative');
    expect(result.access?.value).toBe('unknown');
    expect(ai.calls).toBe(1);
  });

  it('AI exclude → exclude', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: {
        async classify() {
          return { eligibility: 'exclude', evidence: ['canción popular'] };
        },
      },
    });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.method).toBe('ai');
    expect(result.formats).toBeUndefined();
    expect(result.eras).toBeUndefined();
    expect(result.kind).toBeUndefined();
  });

  it('rationale > 800 no tira una clasificación AI válida', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: {
        async classify() {
          return { eligibility: 'exclude', rationale: 'z'.repeat(900) };
        },
      },
    });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.ruleId).toBe('ai-exclude');
    expect(result.eligibility.evidence.some((item) => item.length === 800)).toBe(true);
  });

  it('AI uncertain → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: {
        async classify() {
          return { eligibility: 'uncertain', evidence: ['ficha insuficiente'] };
        },
      },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.method).toBe('ai');
    expect(result.eligibility.ruleId).toBe('ai-uncertain');
    expect(result.formats).toBeUndefined();
  });
});

describe('classifyObserved — degradación segura', () => {
  it('AI throws → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: {
        async classify() {
          throw new Error('red caída');
        },
      },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-error');
    expect(result.eligibility.evidence.join(' ')).toMatch(/red caída/);
  });

  it('AI rejected promise → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: {
        classify: () => Promise.reject(new Error('timeout de red')),
      },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-error');
  });

  it('AI timeout → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: { classify: () => new Promise(() => {}) },
      timeoutMs: 30,
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-timeout');
    expect(result.eligibility.method).toBe('ai');
  });

  it('AI malformed output → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: { async classify() { return 'esto no es JSON de clasificación'; } },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-malformed-output');
  });

  it('AI schema-invalid output → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts, {
      ai: { async classify() { return { eligibility: 'include', formats: ['jazz'] }; } },
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-invalid-output');
    expect(result.formats).toBeUndefined();
  });

  it('provider absent → uncertain', async () => {
    const result = await classifyObserved(uncertainFacts);
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-unavailable');
    expect(result.eligibility.method).toBe('fallback');
  });

  it('un fallo de un evento no impide clasificar el siguiente', async () => {
    let calls = 0;
    const ai: AiClassifier = {
      async classify() {
        calls += 1;
        if (calls === 1) throw new Error('fallo puntual');
        return { eligibility: 'exclude' };
      },
    };
    const first = await classifyObserved(uncertainFacts, { ai });
    const second = await classifyObserved(facts({ title: 'Otro concierto' }), { ai });
    expect(first.eligibility.value).toBe('uncertain');
    expect(second.eligibility.value).toBe('exclude');
    expect(calls).toBe(2);
  });
});

describe('enrichWithAiIfNeeded no reabre include/exclude', () => {
  it('ignora un AI include si el determinista ya excluyó', async () => {
    const deterministic = classify(excludeFacts);
    const result = await enrichWithAiIfNeeded(deterministic, excludeFacts, {
      ai: { async classify() { return { eligibility: 'include' }; } },
    });
    expect(result.eligibility.value).toBe('exclude');
    expect(result.eligibility.method).toBe('rule');
  });
});

describe('OpenAI provider (fetch inyectado, sin red)', () => {
  const observed = uncertainFacts;

  it('devuelve el JSON parseado de una respuesta válida', async () => {
    let requests = 0;
    const provider = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async (_input, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(OPENAI_DEFAULT_MODEL);
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0].content).toBe(AI_CLASSIFIER_SYSTEM_PROMPT);
        expect(body.messages[1].content).toContain(`promptVersion: ${AI_CLASSIFIER_PROMPT_VERSION}`);
        expect(body.messages[1].content).toContain('Concierto extraordinario');
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ eligibility: 'uncertain', evidence: ['ficha genérica'] }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const raw = await provider.classify(observed);
    expect(raw).toEqual({ eligibility: 'uncertain', evidence: ['ficha genérica'] });
    expect(requests).toBe(1);
  });

  it('HTTP error, cuerpo vacío y JSON inválido lanzan', async () => {
    const http = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async () => new Response('nope', { status: 500 }),
    });
    const rateLimited = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async () => new Response('quota', { status: 429 }),
    });
    await expect(rateLimited.classify(observed)).rejects.toThrow(/OpenAI HTTP 429/);
    const rateResult = await classifyObserved(observed, { ai: rateLimited });
    expect(rateResult.eligibility.ruleId).toBe('ai-error');
    expect(rateResult.eligibility.ruleId).not.toBe('ai-rate-limited');

    await expect(http.classify(observed)).rejects.toThrow(/OpenAI HTTP 500/);

    const empty = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 }),
    });
    await expect(empty.classify(observed)).rejects.toThrow(/vacía/);

    const badJson = new OpenAiClassifier({
      apiKey: 'sk-test',
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'no-json' } }] }), { status: 200 }),
    });
    await expect(badJson.classify(observed)).rejects.toThrow(/JSON inválido/);
  });

  it('un fetch colgado degrada a uncertain vía classifyObserved', async () => {
    const provider = new OpenAiClassifier({
      apiKey: 'sk-test',
      timeoutMs: 40,
      fetch: () => new Promise(() => {}),
    });
    const result = await classifyObserved(observed, { ai: provider, timeoutMs: 80 });
    expect(result.eligibility.value).toBe('uncertain');
    expect(['ai-timeout', 'ai-error']).toContain(result.eligibility.ruleId);
  });

  it('constructor sin clave lanza; classifyObserved sigue sin tumbar', async () => {
    expect(() => new OpenAiClassifier({ apiKey: '' })).toThrow(/OPENAI_API_KEY/);
    const result = await classifyObserved(uncertainFacts, {
      ai: createAiClassifierFromEnv({}),
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-unavailable');
  });
});

describe('Gemini provider (fetch inyectado, sin red)', () => {
  const observed = uncertainFacts;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  function geminiStepsResponse(text: string): Response {
    return jsonResponse({
      steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    });
  }

  it('construye Interactions request con modelo, auth, prompt, hechos y schema', async () => {
    let requests = 0;
    const provider = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async (input, init) => {
        requests += 1;
        expect(String(input)).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-goog-api-key')).toBe('gemini-test');
        expect(headers.get('api-revision')).toBe(GEMINI_API_REVISION);
        expect(headers.get('authorization')).toBeNull();
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(GEMINI_DEFAULT_MODEL);
        expect(body.store).toBe(false);
        expect(body.system_instruction).toBe(AI_CLASSIFIER_SYSTEM_PROMPT);
        expect(body.input).toBe(buildAiClassifierUserMessage(observed));
        expect(body.input).toContain(`promptVersion: ${AI_CLASSIFIER_PROMPT_VERSION}`);
        expect(body.input).toContain('Concierto extraordinario');
        expect(body.tools).toBeUndefined();
        expect(body.generation_config?.tool_choice).toBe('none');
        expect(body.response_format).toEqual({
          type: 'text',
          mime_type: 'application/json',
          schema: AI_CLASSIFICATION_JSON_SCHEMA,
        });
        expect(body.response_format.schema.properties).toHaveProperty('eligibility');
        expect(body.response_format.schema.properties).toHaveProperty('formats');
        expect(body.response_format.schema.properties).toHaveProperty('eras');
        expect(body.response_format.schema.properties).toHaveProperty('kind');
        expect(body.response_format.schema.properties).toHaveProperty('evidence');
        expect(body.response_format.schema.properties).toHaveProperty('rationale');
        return geminiStepsResponse(JSON.stringify({ eligibility: 'uncertain', evidence: ['ficha genérica'] }));
      },
    });
    const raw = await provider.classify(observed);
    expect(raw).toEqual({ eligibility: 'uncertain', evidence: ['ficha genérica'] });
    expect(requests).toBe(1);
  });

  it('usa el modelo preferente del pool por defecto y respeta GEMINI_MODEL', async () => {
    const defaultProvider = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe(GEMINI_DEFAULT_MODEL);
        return geminiStepsResponse('{"eligibility":"exclude"}');
      },
    });
    await defaultProvider.classify(observed);

    const override = new GeminiClassifier({
      apiKey: 'gemini-test',
      model: 'gemini-3.5-flash',
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe('gemini-3.5-flash');
        return geminiStepsResponse('{"eligibility":"exclude"}');
      },
    });
    await override.classify(observed);
  });

  it('parsea output_text y steps de una respuesta válida', async () => {
    const fromSteps = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => geminiStepsResponse(JSON.stringify({ eligibility: 'include', kind: 'alternative' })),
    });
    expect(await fromSteps.classify(observed)).toEqual({ eligibility: 'include', kind: 'alternative' });

    const fromSugar = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => jsonResponse({ output_text: '{"eligibility":"uncertain"}' }),
    });
    expect(await fromSugar.classify(observed)).toEqual({ eligibility: 'uncertain' });
  });

  it('HTTP error, 429, cuerpo vacío y JSON inválido lanzan', async () => {
    const http = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => new Response('nope', { status: 500 }),
    });
    await expect(http.classify(observed)).rejects.toThrow(/Gemini HTTP 500/);

    const tooMany = new GeminiClassifier({
      apiKey: 'gemini-test',
      clock: immediateClock(),
      random: () => 0,
      defaultRpm: 60_000,
      fetch: async () => new Response('quota', { status: 429 }),
    });
    await expect(tooMany.classify(observed)).rejects.toBeInstanceOf(AiRateLimitedError);

    const empty = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => jsonResponse({ steps: [{ type: 'model_output', content: [{ type: 'text', text: '   ' }] }] }),
    });
    await expect(empty.classify(observed)).rejects.toThrow(/vacía/);

    const badJson = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => geminiStepsResponse('no-json'),
    });
    await expect(badJson.classify(observed)).rejects.toThrow(/JSON inválido/);
  });

  it('HTTP, 429, timeout y JSON inválido degradan a uncertain vía classifyObserved', async () => {
    const http = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => new Response('boom', { status: 500 }),
    });
    const httpResult = await classifyObserved(observed, { ai: http });
    expect(httpResult.eligibility.value).toBe('uncertain');
    expect(httpResult.eligibility.ruleId).toBe('ai-error');

    const rateLimited = new GeminiClassifier({
      apiKey: 'gemini-test',
      clock: immediateClock(),
      random: () => 0,
      defaultRpm: 60_000,
      fetch: async () => new Response('quota', { status: 429 }),
    });
    const rateResult = await classifyObserved(observed, { ai: rateLimited });
    expect(rateResult.eligibility.value).toBe('uncertain');
    expect(rateResult.eligibility.ruleId).toBe('ai-rate-limited');
    expect(rateResult.eligibility.evidence.join(' ')).toMatch(/429/);

    const hanging = new GeminiClassifier({
      apiKey: 'gemini-test',
      timeoutMs: 40,
      fetch: () => new Promise(() => {}),
    });
    const timeoutResult = await classifyObserved(observed, { ai: hanging, timeoutMs: 80 });
    expect(timeoutResult.eligibility.value).toBe('uncertain');
    expect(['ai-timeout', 'ai-error']).toContain(timeoutResult.eligibility.ruleId);

    const invalid = new GeminiClassifier({
      apiKey: 'gemini-test',
      fetch: async () => geminiStepsResponse('no-json'),
    });
    const invalidResult = await classifyObserved(observed, { ai: invalid });
    expect(invalidResult.eligibility.value).toBe('uncertain');
    expect(invalidResult.eligibility.ruleId).toBe('ai-error');
  });

  it('constructor sin clave lanza', () => {
    expect(() => new GeminiClassifier({ apiKey: '' })).toThrow(/GEMINI_API_KEY/);
  });
});

describe('createAiClassifierFromEnv — selección de provider', () => {
  it('sin credenciales sigue siendo ai-unavailable', async () => {
    expect(createAiClassifierFromEnv({})).toBeUndefined();
    expect(createAiClassifierFromEnv({ OPENAI_API_KEY: '   ', GEMINI_API_KEY: '   ' })).toBeUndefined();
    const result = await classifyObserved(uncertainFacts, {
      ai: createAiClassifierFromEnv({}),
    });
    expect(result.eligibility.value).toBe('uncertain');
    expect(result.eligibility.ruleId).toBe('ai-unavailable');
  });

  it('sin AI_PROVIDER conserva OpenAI si hay OPENAI_API_KEY', () => {
    const built = createAiClassifierFromEnv({ OPENAI_API_KEY: 'sk-test' });
    expect(built).toBeInstanceOf(OpenAiClassifier);
    const both = createAiClassifierFromEnv({
      OPENAI_API_KEY: 'sk-test',
      GEMINI_API_KEY: 'gemini-test',
    });
    expect(both).toBeInstanceOf(OpenAiClassifier);
  });

  it('sin AI_PROVIDER usa Gemini si sólo hay GEMINI_API_KEY', () => {
    const built = createAiClassifierFromEnv({ GEMINI_API_KEY: 'gemini-test' });
    expect(built).toBeInstanceOf(GeminiClassifier);
  });

  it('AI_PROVIDER=gemini exige GEMINI_API_KEY y no cae a OpenAI', () => {
    expect(
      createAiClassifierFromEnv({ AI_PROVIDER: 'gemini', OPENAI_API_KEY: 'sk-test' }),
    ).toBeUndefined();
    const built = createAiClassifierFromEnv({
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-test',
      GEMINI_MODEL: 'gemini-3.5-flash',
    });
    expect(built).toBeInstanceOf(GeminiClassifier);
    expect((built as GeminiClassifier).models).toEqual(['gemini-3.5-flash']);
  });

  it('GEMINI_MODELS gana a GEMINI_MODEL y el default usa el pool', () => {
    const chained = createAiClassifierFromEnv({
      GEMINI_API_KEY: 'gemini-test',
      GEMINI_MODELS: 'gemini-3.1-flash-lite,gemini-2.5-flash',
      GEMINI_MODEL: 'gemini-3.5-flash',
    });
    expect(chained).toBeInstanceOf(GeminiClassifier);
    expect((chained as GeminiClassifier).models).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-flash']);

    const defaults = createAiClassifierFromEnv({ GEMINI_API_KEY: 'gemini-test' }) as GeminiClassifier;
    expect(defaults.models).toEqual(GEMINI_DEFAULT_MODELS);
  });

  it('AI_PROVIDER=openai exige OPENAI_API_KEY y no cae a Gemini', () => {
    expect(
      createAiClassifierFromEnv({ AI_PROVIDER: 'openai', GEMINI_API_KEY: 'gemini-test' }),
    ).toBeUndefined();
    const built = createAiClassifierFromEnv({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(built).toBeInstanceOf(OpenAiClassifier);
  });

  it('AI_PROVIDER desconocido no construye provider', () => {
    expect(
      createAiClassifierFromEnv({
        AI_PROVIDER: 'anthropic',
        OPENAI_API_KEY: 'sk-test',
        GEMINI_API_KEY: 'gemini-test',
      }),
    ).toBeUndefined();
  });
});
