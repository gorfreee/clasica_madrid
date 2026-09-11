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

export const AI_REQUEST_CONTRACT_VERSION = 2;

export type AiGenerationParameters = {
  maxOutputTokens: number;
  temperature?: number;
};

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
    generation: { maxOutputTokens: 600, temperature: 0 },
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
