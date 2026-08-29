export type {
  RawEvent,
  RawOccurrence,
  SourceAdapter,
  SourceDefinition,
  IngestRunSummary,
  HydrationMeta,
  HydrationStatus,
} from './types.ts';
export type { ObservedFacts, ObservedPerson, ObservedWork } from './observed.ts';
export {
  SOURCE_REGISTRY,
  getAdapter,
  getSourceDefinition,
  listSourceDefinitions,
  resolveCatalogSource,
} from './registry.ts';
export { runIngest, extractSource } from './pipeline.ts';
export type { IngestEventDecision, IngestReport } from './report.ts';
export { buildIngestReport, serializeIngestReport, writeIngestReport } from './report.ts';
export { hydrateEvents, memoizeGet } from './hydrate.ts';
export { formatRunSummary } from './summary.ts';
export { normalizeRawEvent, normalizeRawEvents, observedFactsFromNormalized } from './normalize.ts';
export { classify } from './classification/classify.ts';
export { classifyObserved, enrichWithAiIfNeeded } from './classification/enrich.ts';
export { createAiClassifierFromEnv } from './classification/openai.ts';
export type { AiClassifier } from './classification/ai.ts';
export type { ClassificationResult, PublishableClassification, ResolutionMethod } from './classification/types.ts';
export { isPublishableInclude } from './classification/types.ts';
export { resolvePerformerRole } from './classification/performer-role.ts';
export { parseObservedDateTime, parseObservedTime } from './dates.ts';
export { eventIdFor, occurrenceIdFor, toSlug, uniqueId, uniqueSlug } from './ids.ts';
export { mergeCandidateBatch, applyCandidateBatch } from './batch.ts';
export { normalizeUrl } from './urls.ts';
