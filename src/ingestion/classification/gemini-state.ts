/** @deprecated Import the provider-neutral state from ai-state.ts. */
export {
  AiPoolState as GeminiState,
  hashAiInput as hashInput,
  nextPacificQuotaReset as nextQuotaReset,
  pacificQuotaDay as quotaDay,
} from './ai-state.ts';
export type { AiRouteState as ModelState } from './ai-state.ts';
