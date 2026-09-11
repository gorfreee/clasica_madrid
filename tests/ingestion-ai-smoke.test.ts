import { describe, expect, it, vi } from 'vitest';
import type { AiClassifier } from '../src/ingestion/classification/ai.ts';
import { AiTransportError } from '../src/ingestion/classification/ai-transport.ts';
import {
  parseAiSmokeArgs,
  runAiRouteSmoke,
  smokeEnvForRoute,
  splitRouteId,
} from '../src/cli/smoke-ai-route.ts';
import type { ObservedFacts } from '../src/ingestion/observed.ts';

const observed: ObservedFacts = {
  title: 'Concierto de cámara',
  performers: [],
  composers: [],
  works: [],
};

describe('ai:smoke', () => {
  it('parsea route exacta y por defecto un solo purpose', () => {
    expect(parseAiSmokeArgs(['--route', 'mistral:ministral-14b-2512'])).toEqual({
      route: 'mistral:ministral-14b-2512',
      purposes: ['eligibility'],
    });
    expect(parseAiSmokeArgs(['--route', 'zai:glm-4.7-flash', '--purpose', 'taxonomy'])?.purposes).toEqual(['taxonomy']);
    expect(parseAiSmokeArgs(['--route', 'mistral:ministral-8b-2512', '--all-purposes'])?.purposes).toHaveLength(4);
    expect(parseAiSmokeArgs(['--route', 'mistral'])).toBeUndefined();
    expect(splitRouteId('mistral:ministral-14b-2512')).toEqual({
      provider: 'mistral', model: 'ministral-14b-2512',
    });
  });

  it('fuerza zero-cost, cache off y la route pedida', () => {
    expect(smokeEnvForRoute('mistral:ministral-14b-2512', { GROQ_API_KEY: 'keep' })).toMatchObject({
      AI_PROVIDER: 'pool',
      AI_ZERO_COST_ONLY: 'true',
      AI_CACHE: 'off',
      AI_ROUTE: 'mistral:ministral-14b-2512',
      GROQ_API_KEY: 'keep',
    });
  });

  it('reutiliza el classifier inyectado, sanitiza secrets y expone pressure', async () => {
    const classify = vi.fn(async () => {
      throw new AiTransportError('zai HTTP 429: High concurrency usage zai-secret-key', {
        kind: 'rate-limit', status: 429, pressure: 'concurrency', quotaExhausted: false,
        rateLimit: { dimensions: ['concurrency'] },
      });
    });
    const classifier: AiClassifier = {
      classify,
      lastDiagnostics: () => ({
        provider: 'zai',
        model: 'glm-4.7-flash',
        routeId: 'zai:glm-4.7-flash',
        status: '429',
        failures: [{
          provider: 'zai',
          model: 'glm-4.7-flash',
          routeId: 'zai:glm-4.7-flash',
          kind: 'concurrency-pressure',
          pressure: 'concurrency',
          status: '429',
          excerpt: 'High concurrency usage [redacted]',
          rateLimit: { dimensions: ['concurrency'] },
        }],
      }),
      close: vi.fn(),
      initialize: vi.fn(),
    };
    const rows = await runAiRouteSmoke({
      route: 'zai:glm-4.7-flash',
      purposes: ['eligibility'],
      fixtures: [{ purpose: 'eligibility', observed }],
      classifier,
      env: { ZAI_API_KEY: 'zai-secret-key' },
    });
    expect(classify).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'zai',
      model: 'glm-4.7-flash',
      route: 'zai:glm-4.7-flash',
      purpose: 'eligibility',
      success: false,
      schemaValid: false,
      pressure: 'concurrency-pressure',
    });
    expect(JSON.stringify(rows[0])).not.toContain('zai-secret-key');
    expect(classifier.close).toHaveBeenCalledOnce();
  });
});
