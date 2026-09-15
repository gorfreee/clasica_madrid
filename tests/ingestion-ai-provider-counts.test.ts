import { describe, expect, it } from 'vitest';
import { completeProviderCounts, formatProviderCountList } from '../src/ingestion/ai-provider-counts.ts';
import { formatAutomationSummary } from '../src/ingestion/automation.ts';
import { AiPoolClassifier } from '../src/ingestion/classification/ai-pool.ts';
import { createFreeRoutesFromEnv } from '../src/ingestion/classification/provider.ts';
import { formatDiscoveryAutomationSummary } from '../src/ingestion/discovery-automation.ts';
import type { IngestReport } from '../src/ingestion/report.ts';
import { formatRunSummary } from '../src/ingestion/summary.ts';
import {
  emptyIngestAiSummary,
  type IngestAiRouteSummary,
  type IngestAiSummary,
  type IngestRunSummary,
} from '../src/ingestion/types.ts';

const POOL_ENV = {
  AI_ZERO_COST_ONLY: 'true',
  GEMINI_API_KEY: 'gemini-key',
  GROQ_API_KEY: 'groq-key',
  GROQ_FREE_TIER_CONFIRMED: 'true',
  MISTRAL_API_KEY: 'mistral-key',
  MISTRAL_FREE_MODE_CONFIRMED: 'true',
  ZAI_API_KEY: 'zai-key',
  CLOUDFLARE_API_TOKEN: 'cloudflare-token',
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_WORKERS_FREE_CONFIRMED: 'true',
  VERCEL_AI_GATEWAY_API_KEY: 'vercel-key',
  VERCEL_FREE_TIER_CONFIRMED: 'true',
  KILO_API_KEY: 'kilo-key',
  KILO_FREE_TIER_CONFIRMED: 'true',
  OPENROUTER_API_KEY: 'openrouter-key',
  OPENROUTER_FREE_TIER_CONFIRMED: 'true',
} as const;

const POOL_PROVIDERS = [
  'gemini', 'groq', 'mistral', 'cloudflare', 'vercel', 'zai', 'kilo', 'openrouter',
] as const;

describe('completeProviderCounts', () => {
  it('conserva providers con requests > 0', () => {
    expect(completeProviderCounts(
      { gemini: 32, groq: 6 },
      [route('gemini'), route('groq')],
    )).toEqual({ gemini: 32, groq: 6 });
  });

  it('incluye providers presentes en las routes con 0 requests', () => {
    expect(completeProviderCounts(
      { gemini: 32, groq: 6, mistral: 15, cloudflare: 2, zai: 2 },
      ['gemini', 'groq', 'mistral', 'cloudflare', 'vercel', 'zai', 'kilo', 'openrouter'].map(route),
    )).toEqual({
      gemini: 32,
      groq: 6,
      mistral: 15,
      cloudflare: 2,
      vercel: 0,
      zai: 2,
      kilo: 0,
      openrouter: 0,
    });
  });

  it('no inventa un provider sin routes ni counts', () => {
    expect(completeProviderCounts(
      { gemini: 8, groq: 3 },
      [route('gemini'), route('groq')],
    )).toEqual({ gemini: 8, groq: 3 });
    expect(completeProviderCounts({ gemini: 8, groq: 3 }, [route('gemini'), route('groq')])).not.toHaveProperty('vercel');
    expect(completeProviderCounts({ gemini: 8, groq: 3 }, [route('gemini'), route('groq')])).not.toHaveProperty('openai');
  });

  it('mantiene el orden estable de las routes del pool', () => {
    expect(Object.keys(completeProviderCounts(
      { zai: 2, gemini: 32, openrouter: 0, groq: 6 },
      POOL_PROVIDERS.map(route),
    ))).toEqual([...POOL_PROVIDERS]);
  });

  it('aplica el mismo comportamiento a classificationsByProvider', () => {
    expect(completeProviderCounts(
      { mistral: 1 },
      [route('groq'), route('mistral')],
    )).toEqual({ groq: 0, mistral: 1 });
  });

  it('si no hay routes, conserva los counts existentes sin completar el pool', () => {
    expect(completeProviderCounts({ gemini: 8, groq: 3 }, [])).toEqual({ gemini: 8, groq: 3 });
    expect(completeProviderCounts({ gemini: 8, groq: 3 }, undefined)).toEqual({ gemini: 8, groq: 3 });
    expect(completeProviderCounts({}, [])).toEqual({});
  });

  it('formatea celdas GitHub con ceros y orden del pool', () => {
    expect(formatProviderCountList(
      { gemini: 32, zai: 2 },
      POOL_PROVIDERS.map(route),
      'colon',
      'ninguno',
    )).toBe('gemini: 32, groq: 0, mistral: 0, cloudflare: 0, vercel: 0, zai: 2, kilo: 0, openrouter: 0');
    expect(formatProviderCountList({}, [], 'colon', 'ninguno')).toBe('ninguno');
  });
});

describe('summaries de providers IA', () => {
  it('el summary de ingestión muestra ceros y no inventa providers ausentes', () => {
    const text = formatRunSummary(runSummary({
      requestsByProvider: { gemini: 32, groq: 6, mistral: 15, cloudflare: 2, zai: 2 },
      classificationsByProvider: { gemini: 30, mistral: 10 },
      routes: POOL_PROVIDERS.map((provider) => summaryRoute(provider)),
    }));
    expect(text).toContain(
      'requests por provider: gemini=32, groq=6, mistral=15, cloudflare=2, vercel=0, zai=2, kilo=0, openrouter=0',
    );
    expect(text).toContain(
      'clasificaciones por provider: gemini=30, groq=0, mistral=10, cloudflare=0, vercel=0, zai=0, kilo=0, openrouter=0',
    );
    expect(text).not.toContain('openai=');
  });

  it('un pool con Vercel, Kilo y OpenRouter configurados pero sin requests los muestra a 0', () => {
    const classifier = new AiPoolClassifier({
      routes: createFreeRoutesFromEnv(POOL_ENV),
      random: () => 0,
    });
    try {
      const stats = classifier.snapshotStats();
      const text = formatRunSummary(runSummary({
        requestsByProvider: stats.requestsByProvider,
        classificationsByProvider: stats.classificationsByProvider,
        routes: stats.routes,
      }));
      expect(text).toContain(
        'requests por provider: gemini=0, groq=0, mistral=0, cloudflare=0, vercel=0, zai=0, kilo=0, openrouter=0',
      );
      expect(text).toContain(
        'clasificaciones por provider: gemini=0, groq=0, mistral=0, cloudflare=0, vercel=0, zai=0, kilo=0, openrouter=0',
      );
      expect([...new Set(stats.routes.map((item) => item.provider))]).toEqual([...POOL_PROVIDERS]);
    } finally {
      classifier.close();
    }
  });

  it('el summary de GitHub Actions y Discovery usan las routes del pool', () => {
    const report = ingestReport({
      requestsByProvider: { gemini: 32, groq: 6, mistral: 15, cloudflare: 2, zai: 2 },
      classificationsByProvider: { gemini: 30, mistral: 10 },
      routes: POOL_PROVIDERS.map((provider) => summaryRoute(provider)),
    });
    const automation = formatAutomationSummary(report, 'https://example.test/run/1');
    const discovery = formatDiscoveryAutomationSummary(report, 'https://example.test/run/1');
    const expectedRequests =
      'gemini: 32, groq: 6, mistral: 15, cloudflare: 2, vercel: 0, zai: 2, kilo: 0, openrouter: 0';
    const expectedClassifications =
      'gemini: 30, groq: 0, mistral: 10, cloudflare: 0, vercel: 0, zai: 0, kilo: 0, openrouter: 0';
    expect(automation).toContain(`| IA: requests por provider | ${expectedRequests} |`);
    expect(automation).toContain(`| IA: clasificaciones por provider | ${expectedClassifications} |`);
    expect(discovery).toContain(`| IA: requests por provider | ${expectedRequests} |`);
    expect(discovery).toContain(`| IA: clasificaciones por provider | ${expectedClassifications} |`);
  });
});

function route(provider: string, model = 'm'): { provider: string; model?: string } {
  return { provider, model };
}

function summaryRoute(provider: string, model = 'm'): IngestAiRouteSummary {
  return {
    routeId: `${provider}:${model}`,
    provider,
    model,
    httpRequests: 0,
    valid: 0,
    failures: 0,
    failuresByKind: {},
    rateLimits: 0,
    quotaExhausted: 0,
    concurrencyPressure: 0,
    pressureByKind: {},
    circuitOpen: false,
    consecutiveFailures: 0,
  };
}

function runSummary(ai: Partial<IngestAiSummary> = {}): IngestRunSummary {
  return {
    window: { from: '2026-09-15', to: '2026-12-31' },
    health: 'clean',
    autoMergeEligible: true,
    healthReasons: [],
    sourcesAttempted: [],
    sourcesSucceeded: [],
    sourcesFailed: [],
    rawEvents: 0,
    skippedUnusable: 0,
    eligibility: { include: 0, exclude: 0, uncertain: 0 },
    ai: { ...emptyIngestAiSummary(), ...ai },
    candidates: 0,
    newEvents: 0,
    updatedEvents: 0,
    unchangedEvents: 0,
    ambiguous: 0,
    possiblyMissing: 0,
    batchDuplicates: 0,
    crossSourceCorroborations: 0,
    written: [],
    dryRun: true,
    detailHydrationAttempted: 0,
    detailHydrationSucceeded: 0,
    detailHydrationFailed: 0,
  };
}

function ingestReport(ai: Partial<IngestAiSummary> = {}): IngestReport {
  const summary = runSummary(ai);
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-15T12:00:00.000Z',
    dryRun: true,
    window: summary.window,
    health: summary.health,
    autoMergeEligible: summary.autoMergeEligible,
    healthReasons: summary.healthReasons,
    summary,
    events: [],
    possiblyMissing: [],
  };
}
