import type { ObservedFacts } from '../observed.ts';
import { aiJsonSchemaForPurpose, type AiCallPurpose } from './ai.ts';
import {
  AI_ACCESS_SYSTEM_PROMPT,
  AI_CLASSIFIER_SYSTEM_PROMPT,
  AI_COMPOSER_SYSTEM_PROMPT,
  AI_TAXONOMY_SYSTEM_PROMPT,
  buildAiAccessUserMessage,
  buildAiClassifierUserMessage,
  buildAiComposerUserMessage,
  buildAiTaxonomyUserMessage,
} from './ai-prompt.ts';

export const AI_REQUEST_CONTRACT_VERSION = 3;

export type AiGenerationParameters = {
  maxOutputTokens: number;
  temperature?: number;
};

/**
 * Output token cap per purpose. Every provider reads this from `AiRequest.generation`;
 * do not special-case Gemini/Groq/Mistral/Z.AI/Cloudflare here.
 *
 * Sized from the JSON actually returned (not Zod theoretical maxima) plus headroom
 * so a valid reply never has to stop at the cap. Some providers count thinking
 * tokens against this budget (Gemini `thinking_level`; Z.AI thinking is disabled
 * in the transport profile for the same reason). Eligibility historically
 * truncated around 581–600 tokens.
 *
 * access ≪ composer < taxonomy < eligibility. Not a global 600.
 */
export const AI_MAX_OUTPUT_TOKENS_BY_PURPOSE = {
  /** classification + one short evidence span. */
  'access-classification': 256,
  /** a few leftover names, each with a short evidence span. */
  'composer-extraction': 768,
  /** same JSON shape as eligibility, less reasoning. */
  taxonomy: 1024,
  /** largest JSON + thinking headroom after 581–600 truncation. */
  eligibility: 1536,
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
  const prompt = promptForPurpose(observed, purpose);
  return {
    purpose,
    system: prompt.system,
    user: prompt.user,
    schema: aiJsonSchemaForPurpose(purpose),
    generation: { maxOutputTokens: maxOutputTokensForPurpose(purpose), temperature: 0 },
    contractVersion: AI_REQUEST_CONTRACT_VERSION,
  };
}

function promptForPurpose(
  observed: ObservedFacts,
  purpose: AiCallPurpose,
): { system: string; user: string } {
  if (purpose === 'taxonomy') {
    return { system: AI_TAXONOMY_SYSTEM_PROMPT, user: buildAiTaxonomyUserMessage(observed) };
  }
  if (purpose === 'access-classification') {
    return { system: AI_ACCESS_SYSTEM_PROMPT, user: buildAiAccessUserMessage(observed) };
  }
  if (purpose === 'composer-extraction') {
    return { system: AI_COMPOSER_SYSTEM_PROMPT, user: buildAiComposerUserMessage(observed) };
  }
  return { system: AI_CLASSIFIER_SYSTEM_PROMPT, user: buildAiClassifierUserMessage(observed) };
}
