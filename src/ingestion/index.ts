export type {
  RawEvent,
  RawOccurrence,
  SourceAdapter,
  SourceDefinition,
  IngestAiSummary,
  IngestRunSummary,
  HydrationMeta,
  HydrationStatus,
} from './types.ts';
export { emptyIngestAiSummary } from './types.ts';
export type { ObservedFacts, ObservedPerson, ObservedWork } from './observed.ts';
export {
  SOURCE_REGISTRY,
  getAdapter,
  getSourceDefinition,
  listSourceDefinitions,
  resolveCatalogSource,
} from './registry.ts';
export { runIngest, extractSource } from './pipeline.ts';
export type { IngestEventDecision, IngestReport, ReportCandidateSnapshot } from './report.ts';
export { buildIngestReport, buildFatalIngestReport, serializeIngestReport, snapshotCandidate, writeIngestReport } from './report.ts';
export { hydrateEvents, memoizeGet } from './hydrate.ts';
export { formatRunSummary } from './summary.ts';
export { normalizeRawEvent, normalizeRawEvents, observedFactsFromNormalized } from './normalize.ts';
export { classify } from './classification/classify.ts';
export { classifyObserved, enrichWithAiIfNeeded } from './classification/enrich.ts';
export { createAiClassifierFromEnv } from './classification/provider.ts';
export type { AiCallDiagnostics, AiClassifier, AiProviderStats } from './classification/ai.ts';
export { AiRateLimitedError } from './classification/ai.ts';
export type { ClassificationResult, PublishableClassification, ResolutionMethod } from './classification/types.ts';
export { isPublishableInclude } from './classification/types.ts';
export { resolvePerformerRole } from './classification/performer-role.ts';
export {
  parseObservedDateTime,
  parseObservedTime,
  defaultIngestWindow,
  parseIngestWindow,
  isDateInWindow,
  isDateInHarvestScope,
} from './dates.ts';
export type { IngestWindow } from './dates.ts';
export { evaluateIngestHealth } from './health.ts';
export type { IngestHealth } from './health.ts';
export { materialEventDiffs } from './material-diff.ts';
export { eventIdFor, occurrenceIdFor, toSlug, uniqueId, uniqueSlug } from './ids.ts';
export { mergeCandidateBatch, applyCandidateBatch, serializeCanonical } from './batch.ts';
export { matchEventIdentity, EVENT_IDENTITY_ALIASES } from './identity.ts';
export type { EventIdentityAlias, IdentityMatch, IdentityMethod } from './identity.ts';
export { reconcileHarvest } from './reconcile.ts';
export type { ReconcileAction } from './reconcile.ts';
export { findPossiblyMissing } from './disappear.ts';
export type { PossiblyMissingEvent } from './disappear.ts';
export { normalizeUrl } from './urls.ts';
