import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { makeRoute, AiTransportError, type AiRoute, type AiTransportCall, type AiTransportResult } from '../src/ingestion/classification/ai-transport.ts';
import { AiUnusableOutputError } from '../src/ingestion/classification/ai.ts';
import { AI_FREE_PROVIDERS, type AiEnv } from '../src/ingestion/classification/provider.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';
import {
  AI_QUALIFY_PURPOSES,
  type QualifyCase,
} from '../src/ingestion/classification/ai-qualify-dataset.ts';
import { loadQualifyDataset, qualifyCoverageGaps, selectQualifyCases } from '../src/ingestion/classification/ai-qualify-load.ts';
import {
  addCellToTotals,
  emptyRouteTotals,
  percentile,
  rankRoutes,
  scoreQualifyContractFailure,
  scoreQualifyParsed,
  scoreQualifyTransportFailure,
} from '../src/ingestion/classification/ai-qualify-score.ts';
import { parseAiQualifyArgs, runAiQualify } from '../src/cli/ai-qualify.ts';
import { formatAiQualifyMarkdown, writeAiQualifyArtifacts, type QualifyRunJson } from '../src/cli/ai-qualify-report.ts';
import type { AiSmokeDiscovery, AiSmokeProviderStatus } from '../src/cli/ai-smoke.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ALL_FREE_ENV: AiEnv = {
  AI_ZERO_COST_ONLY: 'true',
  GEMINI_API_KEY: 'gemini-live-secret-key',
  GROQ_API_KEY: 'groq-qualify-secret-key',
  GROQ_FREE_TIER_CONFIRMED: 'true',
  MISTRAL_API_KEY: 'mistral-live-secret-key',
  MISTRAL_FREE_MODE_CONFIRMED: 'true',
  ZAI_API_KEY: 'zai-live-secret-key',
  CLOUDFLARE_API_TOKEN: 'cloudflare-live-secret-token',
  CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id-1',
  CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
};

const dataset = await loadQualifyDataset(ROOT);

describe('dataset de qualification', () => {
  it('cubre todas las categorías pedidas y no duplica el smoke', () => {
    expect(qualifyCoverageGaps(dataset)).toEqual([]);
    expect(dataset.length).toBeGreaterThanOrEqual(30);
    expect(dataset.some((item) => item.source.kind === 'golden')).toBe(true);
    expect(new Set(dataset.map((item) => item.purpose))).toEqual(new Set(AI_QUALIFY_PURPOSES));
    expect(selectQualifyCases(dataset, { suite: 'core' }).every((item) => item.core)).toBe(true);
    expect(selectQualifyCases(dataset, { suite: 'core' }).length).toBeLessThan(dataset.length);
    // Gemini flash Free RPD = 18: core must fit one request per case on that model.
    expect(selectQualifyCases(dataset, { suite: 'core' }).length).toBeLessThanOrEqual(18);
    expect(selectQualifyCases(dataset, { suite: 'full', purposes: ['eligibility'] }).every((item) => item.purpose === 'eligibility')).toBe(true);
    expect(selectQualifyCases(dataset, { maxCases: 5 })).toHaveLength(5);
  });

  it('el caso Bach abreviado y el de no inventar reutilizan golden', () => {
    const abbreviated = dataset.find((item) => item.id === 'comp-abreviado-bach');
    const noInvent = dataset.find((item) => item.id === 'comp-no-inventar');
    expect(abbreviated?.goldenCaseId).toBe('golden_bach_brandeburgo');
    expect(abbreviated?.observed.composers).toEqual([]);
    expect(abbreviated?.observed.programText).toMatch(/J\. S\. Bach/);
    expect(noInvent?.goldenCaseId).toBe('golden_scherzo_sokolov');
    expect(noInvent?.expected.composers).toEqual([]);
  });
});

describe('scorer determinista', () => {
  it('acepta exact match y alternativas explícitas', () => {
    const eligibility = scoreQualifyParsed({
      fixture: caseFor('eligibility', { eligibility: 'include' }, facts({ title: 'Concierto', description: 'Sinfonía de Mahler' })),
      parsed: { eligibility: 'include', formats: ['symphonic'], evidence: ['Sinfonía de Mahler'] },
    });
    expect(eligibility).toMatchObject({ transport: 'ok', contract: 'ok', semantic: 'ok', evidence: 'ok' });
    expect(eligibility.failureCategory).toBeUndefined();

    const formats = scoreQualifyParsed({
      fixture: {
        ...caseFor('formats', { formats: ['symphonic', 'choral'], formatAlternatives: [['symphonic']] }, facts({
          title: 'OCNE',
          programText: 'Orquesta y Coro Nacionales',
        })),
      },
      parsed: { formats: ['symphonic'], eras: [], evidence: ['Orquesta y Coro Nacionales'] },
    });
    expect(formats.semantic).toBe('ok');
  });

  it('marca semantic-wrong si la respuesta válida no coincide', () => {
    const score = scoreQualifyParsed({
      fixture: caseFor('eligibility', { eligibility: 'exclude' }, facts({ title: 'Pastora Soler', description: 'Canción popular' })),
      parsed: { eligibility: 'include', formats: [], evidence: ['Canción popular'] },
    });
    expect(score).toMatchObject({
      transport: 'ok', contract: 'ok', semantic: 'fail', failureCategory: 'semantic-wrong',
    });
    expect(score.expected).toBe('exclude');
    expect(score.actual).toBe('include');
  });

  it('acepta J. S. Bach como Johann Sebastian Bach y rechaza extra/intérprete', () => {
    const observed = facts({
      title: 'Bach',
      programText: 'J. S. Bach: Suite orquestal. Ana López, piano.',
      performers: [{ name: 'Ana López', roleText: 'piano' }],
    });
    const ok = scoreQualifyParsed({
      fixture: caseFor('composer-extraction', { composers: ['Johann Sebastian Bach'], composerMatch: 'exact' }, observed),
      parsed: { candidates: [{ name: 'J. S. Bach', evidence: 'J. S. Bach: Suite orquestal' }] },
    });
    expect(ok.semantic).toBe('ok');

    const extra = scoreQualifyParsed({
      fixture: caseFor('composer-extraction', { composers: ['Johann Sebastian Bach'], composerMatch: 'exact', forbiddenComposers: ['Ana López'] }, observed),
      parsed: {
        candidates: [
          { name: 'Johann Sebastian Bach', evidence: 'J. S. Bach: Suite orquestal' },
          { name: 'Ana López', evidence: 'Ana López, piano' },
        ],
      },
    });
    expect(extra.semantic).toBe('fail');
    expect(extra.message).toMatch(/prohibidos|extra/i);
  });

  it('candidates=[] es correcto cuando no debe inventarse compositor', () => {
    const score = scoreQualifyParsed({
      fixture: caseFor('composer-extraction', { composers: [], composerMatch: 'exact' }, facts({
        title: 'Sokolov',
        programText: 'Grigory Sokolov, piano. Programa pendiente de confirmación',
        performers: [{ name: 'Grigory Sokolov', roleText: 'piano' }],
      })),
      parsed: { candidates: [] },
    });
    expect(score.semantic).toBe('ok');
  });

  it('evidence no grounded es un fallo distinto de semantic-wrong', () => {
    const score = scoreQualifyParsed({
      fixture: caseFor('eligibility', { eligibility: 'include' }, facts({ title: 'Concierto de cámara', description: 'Trío con piano' })),
      parsed: { eligibility: 'include', formats: ['chamber'], evidence: ['obra inventada que no está'] },
    });
    expect(score).toMatchObject({
      semantic: 'ok', evidence: 'fail', failureCategory: 'ungrounded-evidence',
    });
  });

  it('access exact match y evidencia localizable', () => {
    const observed = facts({ title: 'Mediodía', accessText: 'Entrada libre hasta completar aforo.' });
    const ok = scoreQualifyParsed({
      fixture: caseFor('access-classification', { access: 'free' }, observed),
      parsed: { classification: 'free', evidence: 'Entrada libre' },
    });
    expect(ok.semantic).toBe('ok');
    expect(ok.evidence).toBe('ok');
    const wrong = scoreQualifyParsed({
      fixture: caseFor('access-classification', { access: 'unknown' }, facts({ title: 'X', accessText: 'Reserva de plaza en taquilla. Aforo limitado.' })),
      parsed: { classification: 'paid', evidence: 'Reserva de plaza' },
    });
    expect(wrong.failureCategory).toBe('semantic-wrong');
  });

  it('eras vacías son un conjunto exacto, no fuzzy', () => {
    const score = scoreQualifyParsed({
      fixture: caseFor('eras', { eras: [] }, facts({ title: 'Ecos de las Tres Culturas' })),
      parsed: { formats: ['early-music'], eras: ['early'], evidence: ['Ecos de las Tres Culturas'] },
    });
    expect(score.semantic).toBe('fail');
    expect(score.expected).toBe('∅');
  });
});

describe('fallos de transporte/contrato y agregados', () => {
  it('timeout y provider-busy no se reescriben como fallo semántico', () => {
    expect(scoreQualifyTransportFailure('timeout').transport).toBe('fail');
    expect(scoreQualifyTransportFailure('timeout').semantic).toBe('n/a');
    expect(scoreQualifyTransportFailure('provider-busy').failureCategory).toBe('provider-busy');
    expect(scoreQualifyContractFailure('schema-invalid').contract).toBe('fail');
    expect(scoreQualifyContractFailure('schema-invalid').transport).toBe('ok');
  });

  it('calcula tasas, percentiles y ranking explicable', () => {
    const strong = emptyRouteTotals();
    const weak = emptyRouteTotals();
    const tiny = emptyRouteTotals();
    for (let i = 0; i < 6; i += 1) {
      addCellToTotals(strong, {
        requestMade: true,
        score: { transport: 'ok', contract: 'ok', semantic: 'ok', evidence: 'ok', expected: 'include', actual: 'include' },
        latencyMs: 100 + i * 10,
        tokens: { input: 20, output: 10, thought: 2 },
      });
      addCellToTotals(weak, {
        requestMade: true,
        score: i < 3
          ? { transport: 'ok', contract: 'ok', semantic: 'fail', evidence: 'ok', expected: 'include', actual: 'exclude', failureCategory: 'semantic-wrong' }
          : { transport: 'ok', contract: 'ok', semantic: 'ok', evidence: 'ok', expected: 'include', actual: 'include' },
        latencyMs: 400,
        tokens: { output: 50 },
      });
    }
    addCellToTotals(tiny, {
      requestMade: true,
      score: { transport: 'ok', contract: 'ok', semantic: 'ok', evidence: 'ok', expected: 'include', actual: 'include' },
      latencyMs: 50,
    });
    expect(percentile(strong.latencies, 0.5)).toBe(125);
    const ranking = rankRoutes('eligibility', [
      { routeId: 'groq:weak', provider: 'groq', model: 'weak', totals: weak },
      { routeId: 'groq:strong', provider: 'groq', model: 'strong', totals: strong },
      { routeId: 'groq:tiny', provider: 'groq', model: 'tiny', totals: tiny },
    ]);
    expect(ranking.map((row) => row.routeId)).toEqual(['groq:strong', 'groq:weak', 'groq:tiny']);
    expect(ranking[0]?.semanticRate).toBe(1);
    expect(ranking[0]?.evidenceRate).toBe(1);
    expect(ranking[1]?.semanticRate).toBe(0.5);
    expect(ranking[2]?.insufficientSample).toBe(true);
  });
});

describe('CLI y runner one-shot', () => {
  it('parsea suite, routes, purposes y max-cases', () => {
    expect(parseAiQualifyArgs([])).toMatchObject({ suite: 'core', allRoutes: true });
    expect(parseAiQualifyArgs(['--suite', 'core', '--purpose', 'eligibility', '--max-cases', '4'])).toMatchObject({
      suite: 'core', allRoutes: true, purposes: ['eligibility'], maxCases: 4,
    });
    expect(parseAiQualifyArgs(['--route', 'groq:openai/gpt-oss-120b', '--providers', 'groq'])).toMatchObject({
      allRoutes: false, routes: ['groq:openai/gpt-oss-120b'], providers: ['groq'],
    });
    expect(parseAiQualifyArgs(['--suite', 'nope'])).toBeUndefined();
    expect(parseAiQualifyArgs(['--all-routes', '--route', 'x:y'])).toBeUndefined();
  });

  it('hace exactamente un request por celda, sin fallback, y clasifica timeout/busy/schema', async () => {
    const counts = new Map<string, number>();
    const fixtures = [
      caseFor('eligibility', { eligibility: 'include' }, facts({ title: 'Concierto', description: 'Sinfonía de Mahler' })),
      caseFor('access-classification', { access: 'free' }, facts({ title: 'Libre', accessText: 'Entrada libre hasta completar aforo.' })),
    ];
    const result = await runAiQualify({
      env: ALL_FREE_ENV,
      fixtures,
      suite: 'full',
      allRoutes: true,
      routes: [],
      providers: [],
      models: [],
      purposes: ['eligibility', 'access-classification'],
      discover: () => discovery([
        fakeRoute('groq:ok', async (call) => {
          bump(counts, 'ok');
          return { value: validFor(call.request.purpose, fixtures[0]!) };
        }),
        fakeRoute('groq:timeout', async () => {
          bump(counts, 'timeout');
          throw new AiTransportError('timeout', { kind: 'timeout' });
        }),
        fakeRoute('zai:busy', async () => {
          bump(counts, 'busy');
          throw new AiTransportError('overload', { kind: 'rate-limit', status: 503, pressure: 'capacity' });
        }),
        fakeRoute('mistral:schema', async () => {
          bump(counts, 'schema');
          return { value: { eligibility: 'nope' } };
        }),
        fakeRoute('gemini:junk', async () => {
          bump(counts, 'junk');
          throw new AiUnusableOutputError('JSON inválido', { kind: 'malformed' });
        }),
      ]),
    });
    expect(Object.fromEntries(counts)).toEqual({ ok: 2, timeout: 2, busy: 2, schema: 2, junk: 2 });
    expect(result.requests).toBe(10);
    expect(result.json.cells.filter((cell) => cell.failureCategory === 'timeout')).toHaveLength(2);
    expect(result.json.cells.filter((cell) => cell.failureCategory === 'provider-busy')).toHaveLength(2);
    expect(result.json.cells.filter((cell) => cell.failureCategory === 'schema-invalid').length).toBeGreaterThan(0);
    expect(result.json.cells.filter((cell) => cell.failureCategory === 'malformed-json')).toHaveLength(2);
    expect(result.markdown).toContain('## Eligibility');
    expect(result.markdown).toContain('## Access');
    expect(result.markdown).toContain('Suggested route ranking by purpose');
    expect(result.json.kind).toBe('ai-qualification');
    expect(result.json.contractVersion).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it('incomplete por tope de tokens es output-limit', async () => {
    const fixtures = [caseFor('eligibility', { eligibility: 'include' }, facts({ title: 'Concierto', description: 'Sinfonía de Mahler' }))];
    const result = await runAiQualify({
      env: ALL_FREE_ENV,
      fixtures,
      suite: 'full',
      allRoutes: true,
      routes: [],
      providers: [],
      models: [],
      purposes: ['eligibility'],
      discover: () => discovery([fakeRoute('gemini:capped', async () => {
        throw new AiUnusableOutputError('incomplete', {
          kind: 'incomplete',
          status: 'incomplete',
          finishReason: 'max_tokens',
          tokens: { input: 100, output: 700 },
        });
      })]),
    });
    expect(result.json.cells[0]?.failureCategory).toBe('output-limit');
    expect(result.json.cells[0]?.contract).toBe('fail');
  });

  it('AUTH bloquea el resto de la route y no llama a otro modelo', async () => {
    let groq = 0;
    let mistral = 0;
    const fixtures = dataset.filter((item) => item.purpose === 'eligibility').slice(0, 3);
    const result = await runAiQualify({
      env: ALL_FREE_ENV,
      fixtures,
      suite: 'full',
      allRoutes: true,
      routes: [],
      providers: [],
      models: [],
      purposes: ['eligibility'],
      discover: () => discovery([
        fakeRoute('groq:auth', async () => {
          groq += 1;
          throw new AiTransportError('HTTP 401', { kind: 'auth', status: 401 });
        }),
        fakeRoute('mistral:ok', async (call) => {
          mistral += 1;
          return { value: validFor(call.request.purpose, fixtures[0]!) };
        }),
      ]),
    });
    expect(groq).toBe(1);
    expect(mistral).toBe(3);
    expect(result.json.cells.filter((cell) => cell.routeId === 'groq:auth').map((cell) => cell.failureCategory)).toEqual([
      'auth', 'blocked', 'blocked',
    ]);
  });

  it('publica summary/JSON sin secretos y con expected/actual', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-qualify-'));
    try {
      const fixtures = [caseFor('eligibility', { eligibility: 'include' }, facts({ title: 'Concierto', description: 'Sinfonía de Mahler' }))];
      const result = await runAiQualify({
        env: ALL_FREE_ENV,
        fixtures,
        suite: 'core',
        allRoutes: true,
        routes: [],
        providers: [],
        models: [],
        purposes: ['eligibility'],
        timestamp: '2026-09-12T12:00:00.000Z',
        commitSha: 'abc1234',
        discover: () => discovery([fakeRoute('groq:wrong', async () => ({
          value: { eligibility: 'exclude', formats: [], evidence: ['Sinfonía de Mahler'] },
        }))]),
      });
      await writeAiQualifyArtifacts({
        markdown: result.markdown,
        json: result.json,
        reportDir: dir,
        summaryPath: path.join(dir, 'summary.md'),
        env: ALL_FREE_ENV as NodeJS.ProcessEnv,
      });
      const md = await readFile(path.join(dir, 'ai-qualify-report.md'), 'utf8');
      const json = JSON.parse(await readFile(path.join(dir, 'ai-qualify-report.json'), 'utf8')) as QualifyRunJson;
      expect(md).toContain('## Fallos');
      expect(md).toContain('eligibility-test');
      expect(md).toContain('semantic-wrong');
      expect(json.commitSha).toBe('abc1234');
      expect(json.dataset.id).toBe('clasica-madrid-ai-qualify-v1');
      expect(json.cells[0]).toMatchObject({ expected: 'include', actual: 'exclude' });
      expect(`${md}\n${JSON.stringify(json)}`).not.toContain('groq-qualify-secret-key');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('markdown summary', () => {
  it('incluye tablas por route y por purpose', () => {
    const markdown = formatAiQualifyMarkdown({
      json: {
        schemaVersion: 1,
        kind: 'ai-qualification',
        timestamp: '2026-09-12T12:00:00.000Z',
        commitSha: 'deadbeef',
        dataset: { id: 'clasica-madrid-ai-qualify-v1', schemaVersion: 1, caseCount: 2, suite: 'core' },
        contractVersion: 4,
        promptVersions: { eligibility: 13, taxonomy: 9, access: 3, composer: 4 },
        config: { suite: 'core', purposes: ['eligibility', 'formats'], timeoutMs: 30_000, zeroCost: true },
        durationMs: 1200,
        requests: 2,
        cells: [],
        routes: [{
          routeId: 'groq:openai/gpt-oss-120b',
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          totals: {
            cases: 2, requests: 2, transportOk: 2, schemaOk: 2, semanticOk: 2, evidenceOk: 2,
            latencies: [100, 200], inputTokens: 40, outputTokens: 12, thoughtTokens: 3,
          },
          byPurpose: {
            eligibility: {
              cases: 1, requests: 1, transportOk: 1, schemaOk: 1, semanticOk: 1, evidenceOk: 1,
              latencies: [100], inputTokens: 20, outputTokens: 6, thoughtTokens: 1,
            },
          },
          insufficientSample: true,
        }],
        rankingByPurpose: {
          eligibility: [{
            purpose: 'eligibility', routeId: 'groq:openai/gpt-oss-120b', provider: 'groq',
            model: 'openai/gpt-oss-120b', rank: 1, insufficientSample: true,
            semanticRate: 1, evidenceRate: 1, schemaRate: 1, transportRate: 1, p50Ms: 100, outputTokens: 6,
          }],
        },
      },
      purposes: ['eligibility', 'formats'],
    });
    expect(markdown).toContain('# AI qualification benchmark');
    expect(markdown).toContain('## Resumen general');
    expect(markdown).toContain('## Eligibility');
    expect(markdown).toContain('## Formats');
    expect(markdown).toContain('Suggested route ranking');
    expect(markdown).toContain('| Provider | Model | Semantic | Evidence | Schema | Transport |');
    expect(markdown).toContain('insufficient');
    expect(markdown).toContain('deadbeef');
  });
});

function facts(overrides: Partial<ObservedFacts> & Pick<ObservedFacts, 'title'>): ObservedFacts {
  return { performers: [], composers: [], works: [], ...overrides };
}

function caseFor(purpose: QualifyCase['purpose'], expected: QualifyCase['expected'], observed: ObservedFacts): QualifyCase {
  return {
    id: `${purpose}-test`,
    purpose,
    category: 'test',
    core: true,
    source: { kind: 'inline' },
    observed,
    expected,
  };
}

function validFor(purpose: string, fixture: QualifyCase): unknown {
  if (purpose === 'access-classification') {
    return { classification: fixture.expected.access ?? 'free', evidence: fixture.observed.accessText ?? 'Entrada libre' };
  }
  if (purpose === 'composer-extraction') {
    return { candidates: (fixture.expected.composers ?? []).map((name) => ({ name, evidence: name })) };
  }
  if (purpose === 'taxonomy') {
    return {
      formats: fixture.expected.formats ?? ['symphonic'],
      eras: fixture.expected.eras ?? [],
      evidence: [fixture.observed.title],
    };
  }
  return {
    eligibility: fixture.expected.eligibility ?? 'include',
    formats: ['symphonic'],
    evidence: [fixture.observed.description ?? fixture.observed.title],
  };
}

function fakeRoute(
  routeId: string,
  request: (call: AiTransportCall) => Promise<AiTransportResult>,
): AiRoute {
  const separator = routeId.indexOf(':');
  return makeRoute({
    provider: routeId.slice(0, separator),
    model: routeId.slice(separator + 1),
    transport: { provider: routeId.slice(0, separator), request, cacheIdentity: () => ({ routeId }) },
  });
}

function discovery(routes: AiRoute[]): AiSmokeDiscovery {
  return { routes, providers: allReady(routes) };
}

function allReady(routes: AiRoute[]): AiSmokeProviderStatus[] {
  return AI_FREE_PROVIDERS.map((provider) => ({
    provider,
    status: 'ready' as const,
    routeIds: routes.filter((route) => route.provider === provider).map((route) => route.routeId),
  }));
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
