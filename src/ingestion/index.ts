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
export { hydrateEvents, memoizeGet } from './hydrate.ts';
export { formatRunSummary } from './summary.ts';
export { normalizeRawEvent, normalizeRawEvents } from './normalize.ts';
export { classify } from './classification/classify.ts';
export type { ClassificationResult } from './classification/types.ts';
export { parseObservedDateTime, parseObservedTime } from './dates.ts';
export { eventIdFor, occurrenceIdFor, toSlug, uniqueId, uniqueSlug } from './ids.ts';
export { mergeCandidateBatch, applyCandidateBatch } from './batch.ts';
export { normalizeUrl } from './urls.ts';
