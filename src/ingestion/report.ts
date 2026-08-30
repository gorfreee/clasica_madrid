import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate } from '../lib/schemas/candidate.ts';
import type { Event, Occurrence } from '../lib/schemas/event.ts';
import type { AccessMode, Era, EventKind, Format } from '../lib/schemas/taxonomies.ts';
import type { Eligibility } from './classification/golden-case.ts';
import type { ClassificationResult, Resolution, ResolutionMethod } from './classification/types.ts';
import type { IngestHealth } from './health.ts';
import type { PossiblyMissingEvent } from './disappear.ts';
import type { IdentityMethod } from './identity.ts';
import type { ReconcileAction } from './reconcile.ts';
import type { NormalizedEvent } from './normalize.ts';
import type { ObservedComposer, ObservedPerson, ObservedWork } from './observed.ts';
import type { IngestRunSummary, RawEvent } from './types.ts';
import { emptyIngestAiSummary } from './types.ts';
import type { IngestWindow } from './dates.ts';
import type { AiCallDiagnostics } from './classification/ai.ts';

const MAX_DIAGNOSTIC_TEXT = 4000;

export type IngestFailureInfo = {
  code: string;
  message: string;
  stage?: string;
  sourceId?: string;
  sourceUrl?: string;
};

export type DiagnosticOccurrence = {
  raw?: string;
  date?: string;
  time?: string | null;
};

/**
 * Adapter-visible facts for debugging. Not the canonical Event schema.
 * `listing` is the pre-hydration snapshot; `observed` is what normalize saw.
 */
export type DiagnosticObservedFacts = {
  title: string;
  description?: string;
  categoryText?: string;
  venueText?: string;
  organizerText?: string;
  seriesText?: string;
  accessText?: string;
  programText?: string;
  performers: ObservedPerson[];
  composers: ObservedComposer[];
  works: ObservedWork[];
  occurrences: DiagnosticOccurrence[];
  eventStatus?: RawEvent['eventStatus'];
  venueFacilityId?: string;
};

export type DiagnosticNormalizedFacts = {
  title: string;
  description?: string;
  categoryText?: string;
  venueText?: string;
  organizerText?: string;
  seriesText?: string;
  accessText?: string;
  programText?: string;
  performers: ObservedPerson[];
  composers: ObservedComposer[];
  works: ObservedWork[];
  occurrences: Array<{ date: string; time: string | null }>;
  dateFromDetail?: boolean;
  eventStatus?: NormalizedEvent['eventStatus'];
  venueFacilityId?: string;
};

export type FieldResolution<T> = {
  value: T;
  method: ResolutionMethod;
  ruleId: string;
};

/**
 * Per-observed-event diagnostic. Internal to the ingest run; never written to
 * `data/events/**` and never sent to the classifier.
 */
export type IngestEventDecision = {
  sourceId: string;
  sourceUrl: string;
  externalId?: string;
  title: string;
  hydration: NonNullable<RawEvent['hydration']>;
  structuralSkip?: {
    reason: string;
  };
  eligibility?: {
    value: Eligibility;
    method: ResolutionMethod;
    ruleId: string;
    evidence: string[];
  };
  aiAttempted: boolean;
  /**
   * Transport diagnostics for the AI call, when the provider exposes them.
   * Never written to `data/**`.
   */
  ai?: AiCallDiagnostics;
  formats?: FieldResolution<Format[]>;
  eras?: FieldResolution<Era[]>;
  kind?: FieldResolution<EventKind>;
  access?: FieldResolution<AccessMode>;
  publishable: boolean;
  candidateGenerated: boolean;
  identity?: {
    action?: ReconcileAction;
    method?: IdentityMethod;
    eventId?: string;
    eventIds?: string[];
    reason?: string;
  };
  fieldDiffs?: string[];
  classificationDrift?: {
    eligibility: 'exclude' | 'uncertain';
    ruleId: string;
  };
  scheduleChange?: 'cancelled' | 'postponed';
  batchDuplicate?: boolean;
  /**
   * Incoming canonical/enrichment values that were not applied to a
   * published event. Diagnostic only; never written to `data/**`.
   */
  mergeDiagnostics?: string[];
  /**
   * Listing facts before detail hydration. Present only when hydration
   * succeeded, so listing vs observed shows what the ficha added.
   */
  listing?: DiagnosticObservedFacts;
  /**
   * Post-hydration facts that entered normalize/classify.
   */
  observed?: DiagnosticObservedFacts;
  /**
   * Facts after normalization; this is what classification and identity used.
   */
  normalized?: DiagnosticNormalizedFacts;
  /**
   * Diagnostic projection of the Candidate that would be written.
   * Present only when a Candidate exists. Not sent to the classifier.
   */
  candidate?: ReportCandidateSnapshot;
};

/**
 * Inspectable facts from a generated Candidate. Reuses Event/Occurrence
 * field types; omits citations and related entities.
 */
export type ReportCandidateSnapshot = Pick<
  Event,
  | 'id'
  | 'slug'
  | 'status'
  | 'venueId'
  | 'performers'
  | 'composers'
  | 'works'
  | 'eras'
  | 'formats'
  | 'kind'
  | 'access'
> & {
  occurrences: Array<Pick<Occurrence, 'date' | 'time' | 'status'>>;
};

export type IngestReport = {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: boolean;
  window: IngestWindow;
  health: IngestHealth;
  autoMergeEligible: boolean;
  healthReasons: string[];
  summary: IngestRunSummary;
  events: IngestEventDecision[];
  possiblyMissing: PossiblyMissingEvent[];
  failure?: IngestFailureInfo;
};

export type DecisionInput = {
  raw: RawEvent;
  title: string;
  structuralSkip?: string;
  classification?: ClassificationResult;
  aiAttempted: boolean;
  ai?: IngestEventDecision['ai'];
  publishable: boolean;
  candidateGenerated: boolean;
  identity?: IngestEventDecision['identity'];
  fieldDiffs?: string[];
  classificationDrift?: IngestEventDecision['classificationDrift'];
  scheduleChange?: IngestEventDecision['scheduleChange'];
  batchDuplicate?: boolean;
  mergeDiagnostics?: string[];
  listing?: RawEvent;
  normalizedEvent?: NormalizedEvent;
  candidate?: Candidate;
};

export function buildEventDecision(input: DecisionInput): IngestEventDecision {
  const hydrationStatus = input.raw.hydration?.status ?? 'not-requested';
  const decision: IngestEventDecision = {
    sourceId: input.raw.sourceId,
    sourceUrl: input.raw.sourceUrl,
    title: input.title,
    hydration: {
      ...input.raw.hydration,
      status: hydrationStatus,
      ...(input.raw.hydration?.message ? { message: input.raw.hydration.message } : {}),
    },
    aiAttempted: input.aiAttempted,
    publishable: input.publishable,
    candidateGenerated: input.candidateGenerated,
  };
  if (input.raw.externalId) decision.externalId = input.raw.externalId;
  if (input.structuralSkip) decision.structuralSkip = { reason: input.structuralSkip };
  if (input.identity) decision.identity = input.identity;
  if (input.fieldDiffs && input.fieldDiffs.length > 0) decision.fieldDiffs = input.fieldDiffs;
  if (input.mergeDiagnostics && input.mergeDiagnostics.length > 0) {
    decision.mergeDiagnostics = input.mergeDiagnostics;
  }
  if (input.classificationDrift) decision.classificationDrift = input.classificationDrift;
  if (input.scheduleChange) decision.scheduleChange = input.scheduleChange;
  if (input.batchDuplicate) decision.batchDuplicate = true;
  if (input.ai) decision.ai = input.ai;
  if (input.candidate) decision.candidate = snapshotCandidate(input.candidate);
  decision.observed = snapshotObservedFacts(input.raw);
  if (input.normalizedEvent) decision.normalized = snapshotNormalizedFacts(input.normalizedEvent);
  if (input.listing && (input.raw.hydration?.status ?? 'not-requested') === 'succeeded') {
    decision.listing = snapshotObservedFacts(input.listing);
  }

  const classification = input.classification;
  if (classification) {
    decision.eligibility = {
      value: classification.eligibility.value,
      method: classification.eligibility.method,
      ruleId: classification.eligibility.ruleId,
      evidence: classification.eligibility.evidence,
    };
    const formats = fieldOf(classification.formats);
    if (formats) decision.formats = formats;
    const eras = fieldOf(classification.eras);
    if (eras) decision.eras = eras;
    const kind = fieldOf(classification.kind);
    if (kind) decision.kind = kind;
    const access = fieldOf(classification.access);
    if (access) decision.access = access;
  }

  return decision;
}

export function buildIngestReport(
  run: {
    summary: IngestRunSummary;
    decisions: IngestEventDecision[];
    possiblyMissing?: PossiblyMissingEvent[];
  },
  generatedAt: Date,
): IngestReport {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    dryRun: run.summary.dryRun,
    window: run.summary.window,
    health: run.summary.health,
    autoMergeEligible: run.summary.autoMergeEligible,
    healthReasons: run.summary.healthReasons,
    summary: run.summary,
    events: run.decisions,
    possiblyMissing: run.possiblyMissing ?? [],
  };
}

export function buildFatalIngestReport(options: {
  generatedAt: Date;
  dryRun: boolean;
  window: IngestWindow;
  reasons: readonly string[];
  failure?: IngestFailureInfo;
}): IngestReport {
  const summary: IngestRunSummary = {
    window: options.window,
    health: 'fatal',
    autoMergeEligible: false,
    healthReasons: [...options.reasons],
    sourcesAttempted: [],
    sourcesSucceeded: [],
    sourcesFailed: [],
    rawEvents: 0,
    skippedUnusable: 0,
    eligibility: { include: 0, exclude: 0, uncertain: 0 },
    ai: emptyIngestAiSummary(),
    candidates: 0,
    newEvents: 0,
    updatedEvents: 0,
    unchangedEvents: 0,
    ambiguous: 0,
    possiblyMissing: 0,
    batchDuplicates: 0,
    written: [],
    dryRun: options.dryRun,
    detailHydrationAttempted: 0,
    detailHydrationSucceeded: 0,
    detailHydrationFailed: 0,
  };
  const report = buildIngestReport({ summary, decisions: [], possiblyMissing: [] }, options.generatedAt);
  if (options.failure) report.failure = options.failure;
  return report;
}

export function serializeIngestReport(report: IngestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeIngestReport(filePath: string, report: IngestReport): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeIngestReport(report), 'utf8');
}

export function writeIngestReportSync(filePath: string, report: IngestReport): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeIngestReport(report), 'utf8');
}

export function snapshotObservedFacts(raw: RawEvent): DiagnosticObservedFacts {
  const observed = raw.observed;
  const snapshot: DiagnosticObservedFacts = {
    title: clipText(observed.title),
    performers: observed.performers.map(clonePerson),
    composers: observed.composers.map(cloneComposer),
    works: observed.works.map(cloneWork),
    occurrences: observed.occurrences.map((item) => ({
      ...(item.raw ? { raw: clipText(item.raw) } : {}),
      ...(item.date ? { date: item.date } : {}),
      ...(item.time ? { time: item.time } : {}),
    })),
  };
  if (observed.description) snapshot.description = clipText(observed.description);
  if (observed.categoryText) snapshot.categoryText = clipText(observed.categoryText);
  if (observed.venueText) snapshot.venueText = clipText(observed.venueText);
  if (observed.organizerText) snapshot.organizerText = clipText(observed.organizerText);
  if (observed.seriesText) snapshot.seriesText = clipText(observed.seriesText);
  if (observed.accessText) snapshot.accessText = clipText(observed.accessText);
  if (observed.programText) snapshot.programText = clipText(observed.programText);
  if (raw.eventStatus) snapshot.eventStatus = raw.eventStatus;
  if (raw.venueFacilityId) snapshot.venueFacilityId = raw.venueFacilityId;
  return snapshot;
}

export function snapshotNormalizedFacts(event: NormalizedEvent): DiagnosticNormalizedFacts {
  const snapshot: DiagnosticNormalizedFacts = {
    title: clipText(event.title),
    performers: event.performers.map(clonePerson),
    composers: event.composers.map(cloneComposer),
    works: event.works.map(cloneWork),
    occurrences: event.occurrences.map((item) => ({ date: item.date, time: item.time })),
  };
  if (event.description) snapshot.description = clipText(event.description);
  if (event.categoryText) snapshot.categoryText = clipText(event.categoryText);
  if (event.venueText) snapshot.venueText = clipText(event.venueText);
  if (event.organizerText) snapshot.organizerText = clipText(event.organizerText);
  if (event.seriesText) snapshot.seriesText = clipText(event.seriesText);
  if (event.accessText) snapshot.accessText = clipText(event.accessText);
  if (event.programText) snapshot.programText = clipText(event.programText);
  if (event.dateFromDetail) snapshot.dateFromDetail = true;
  if (event.eventStatus) snapshot.eventStatus = event.eventStatus;
  if (event.venueFacilityId) snapshot.venueFacilityId = event.venueFacilityId;
  return snapshot;
}

export function snapshotCandidate(candidate: Candidate): ReportCandidateSnapshot {
  const event = candidate.event;
  return {
    id: event.id,
    slug: event.slug,
    status: event.status,
    venueId: event.venueId,
    occurrences: event.occurrences.map((item) => ({
      date: item.date,
      time: item.time,
      status: item.status,
    })),
    performers: event.performers,
    composers: event.composers,
    works: event.works,
    eras: event.eras,
    formats: event.formats,
    kind: event.kind,
    access: event.access,
  };
}

function fieldOf<T>(resolution: Resolution<T> | undefined): FieldResolution<T> | undefined {
  if (!resolution) return undefined;
  return {
    value: resolution.value,
    method: resolution.method,
    ruleId: resolution.ruleId,
  };
}

function clipText(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_TEXT) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_TEXT)}…[truncated]`;
}

function clonePerson(item: ObservedPerson): ObservedPerson {
  return item.roleText ? { name: clipText(item.name), roleText: clipText(item.roleText) } : { name: clipText(item.name) };
}

function cloneComposer(item: ObservedComposer): ObservedComposer {
  return { name: clipText(item.name) };
}

function cloneWork(item: ObservedWork): ObservedWork {
  return item.composerName
    ? { title: clipText(item.title), composerName: clipText(item.composerName) }
    : { title: clipText(item.title) };
}
