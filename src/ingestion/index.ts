export type {
  RawEvent,
  RawOccurrence,
  SourceAdapter,
  SourceDefinition,
  PipelineSource,
  ProposedVenueFacts,
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
export { runIngest, runDiscoveryIngest, extractSource } from './pipeline.ts';
export type { IngestEventDecision, IngestReport, ReportCandidateSnapshot, IngestFailureInfo } from './report.ts';
export {
  buildIngestReport,
  buildFatalIngestReport,
  serializeIngestReport,
  snapshotCandidate,
  snapshotObservedFacts,
  snapshotNormalizedFacts,
  writeIngestReport,
  writeIngestReportSync,
} from './report.ts';
export { hydrateEvents, memoizeGet } from './hydrate.ts';
export { formatRunSummary } from './summary.ts';
export { normalizeRawEvent, normalizeRawEvents, observedFactsFromNormalized } from './normalize.ts';
export { classify } from './classification/classify.ts';
export { classifyObserved, enrichWithAiIfNeeded } from './classification/enrich.ts';
export { createAiClassifierFromEnv } from './classification/provider.ts';
export type { AiCallDiagnostics, AiClassifier, AiProviderStats } from './classification/ai.ts';
export { AiRateLimitedError, AiUnusableOutputError } from './classification/ai.ts';
export type { ClassificationResult, PublishableClassification, ResolutionMethod } from './classification/types.ts';
export { isPublishableInclude, isTechnicalClassificationFailure } from './classification/types.ts';
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
export {
  canonicalizeEventTitle,
  planPublishedTitleCanonicalization,
  replacePublishedTitle,
} from './event-title.ts';
export type { PublishedTitleChange } from './event-title.ts';
export { eventIdFor, occurrenceIdFor, toSlug, uniqueId, uniqueSlug } from './ids.ts';
export { mergeCandidateBatch, applyCandidateBatch, serializeCanonical } from './batch.ts';
export { matchEventIdentity, EVENT_IDENTITY_ALIASES } from './identity.ts';
export type { EventIdentityAlias, IdentityMatch, IdentityMethod } from './identity.ts';
export { reconcileHarvest } from './reconcile.ts';
export type { ReconcileAction } from './reconcile.ts';
export { findPossiblyMissing } from './disappear.ts';
export type { PossiblyMissingEvent } from './disappear.ts';
export { normalizeUrl } from './urls.ts';
export {
  parseDiscoveryBatch,
  discoveryToRawEvents,
  discoveryBatchJsonSchema,
  DiscoveryBatchError,
  SHARED_SOURCE_HOSTS,
} from './discovery.ts';
export type { DiscoveryBatch, DiscoveryObservation } from './discovery.ts';
export {
  buildDiscoveryContext,
  parseDiscoveryContext,
  serializeDiscoveryContext,
  DiscoveryContextError,
  discoveryContextSchema,
} from './discovery-context.ts';
export type { DiscoveryContext } from './discovery-context.ts';
export { isSufficientProposedVenue, proposeDiscoveryVenue } from './venues.ts';
export {
  IngestObservability,
  startObservability,
  sanitizeErrorMessage,
  classifyFailureCode,
} from './observability.ts';
export type {
  IngestRunManifest,
  IngestRunStage,
  IngestRunStatus,
  IngestJournalEntry,
} from './observability.ts';
