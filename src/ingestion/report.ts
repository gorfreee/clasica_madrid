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
import type { IngestRunSummary, RawEvent } from './types.ts';
import { emptyIngestAiSummary } from './types.ts';
import type { IngestWindow } from './dates.ts';
import type { AiCallDiagnostics } from './classification/ai.ts';

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
  hydration: {
    status: NonNullable<RawEvent['hydration']>['status'];
    message?: string;
  };
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
  candidate?: Candidate;
};

export function buildEventDecision(input: DecisionInput): IngestEventDecision {
  const hydrationStatus = input.raw.hydration?.status ?? 'not-requested';
  const decision: IngestEventDecision = {
    sourceId: input.raw.sourceId,
    sourceUrl: input.raw.sourceUrl,
    title: input.title,
    hydration: {
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
  return buildIngestReport({ summary, decisions: [], possiblyMissing: [] }, options.generatedAt);
}

export function serializeIngestReport(report: IngestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeIngestReport(filePath: string, report: IngestReport): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeIngestReport(report), 'utf8');
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
