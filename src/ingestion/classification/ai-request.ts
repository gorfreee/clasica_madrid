import type { ObservedFacts } from '../observed.ts';
import { aiJsonSchemaForPurpose, type AiCallPurpose } from './ai.ts';
import {
  AI_ACCESS_SYSTEM_PROMPT,
  AI_CLASSIFIER_SYSTEM_PROMPT,
  AI_COMPOSER_SYSTEM_PROMPT,
  AI_TAXONOMY_SYSTEM_PROMPT,
  buildAiUserMessage,
} from './ai-prompt.ts';

export const AI_REQUEST_CONTRACT_VERSION = 4;

export type AiGenerationParameters = {
  maxOutputTokens: number;
  temperature?: number;
};

/**
 * Output token cap per purpose. Every provider reads this from `AiRequest.generation`;
 * do not special-case Gemini/Groq/Mistral/Z.AI/Cloudflare here.
 *
 * Sized from the compact JSON each purpose actually returns after the contract
 * split (no rationale/kind; eligibility no longer asks for eras; evidence ≤ 4
 * spans), plus modest headroom. Not raised to paper over repetition/MAX_TOKENS
 * loops: a small schema that loops will still loop with a bigger cap.
 *
 * Typical payloads:
 * - access: `{"classification":"free","evidence":"…"}` (~40–80 tokens)
 * - taxonomy: formats[] + eras[] + ≤4 short spans (~80–200 tokens)
 * - composer: a handful of `{name, evidence}` objects, not the 20-item ceiling
 * - eligibility: eligibility + optional formats + ≤4 spans (~80–250 tokens)
 *
 * access < taxonomy < composer < eligibility.
 */
export const AI_MAX_OUTPUT_TOKENS_BY_PURPOSE = {
  'access-classification': 192,
  taxonomy: 384,
  'composer-extraction': 512,
  eligibility: 768,
} as const satisfies Record<AiCallPurpose, number>;

export function maxOutputTokensForPurpose(purpose: AiCallPurpose): number {
  return AI_MAX_OUTPUT_TOKENS_BY_PURPOSE[purpose];
}

/** Provider-neutral request. Prompt and editorial schema are built once here. */
export type AiRequest = {
  purpose: AiCallPurpose;
  system: string;
  user: string;
  schema: object;
  generation: AiGenerationParameters;
  contractVersion: number;
};

export function buildAiRequest(
  observed: ObservedFacts,
  purpose: AiCallPurpose = 'eligibility',
): AiRequest {
  return {
    purpose,
    system: systemForPurpose(purpose),
    user: buildAiUserMessage(observed, purpose),
    schema: aiJsonSchemaForPurpose(purpose),
    generation: { maxOutputTokens: maxOutputTokensForPurpose(purpose), temperature: 0 },
    contractVersion: AI_REQUEST_CONTRACT_VERSION,
  };
}

function systemForPurpose(purpose: AiCallPurpose): string {
  if (purpose === 'taxonomy') return AI_TAXONOMY_SYSTEM_PROMPT;
  if (purpose === 'access-classification') return AI_ACCESS_SYSTEM_PROMPT;
  if (purpose === 'composer-extraction') return AI_COMPOSER_SYSTEM_PROMPT;
  return AI_CLASSIFIER_SYSTEM_PROMPT;
}
