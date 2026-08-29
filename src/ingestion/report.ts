import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccessMode, Era, EventKind, Format } from '../lib/schemas/taxonomies.ts';
import type { Eligibility } from './classification/golden-case.ts';
import type { ClassificationResult, Resolution, ResolutionMethod } from './classification/types.ts';
import type { IngestRunSummary, RawEvent } from './types.ts';

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
  ai?: {
    model?: string;
    fallbackUsed?: boolean;
    attempts?: number;
  };
  formats?: FieldResolution<Format[]>;
  eras?: FieldResolution<Era[]>;
  kind?: FieldResolution<EventKind>;
  access?: FieldResolution<AccessMode>;
  publishable: boolean;
  candidateGenerated: boolean;
  identity?: 'existing' | 'new';
};

export type IngestReport = {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: boolean;
  summary: IngestRunSummary;
  events: IngestEventDecision[];
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
  identity?: 'existing' | 'new';
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
  if (input.ai) decision.ai = input.ai;

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
  run: { summary: IngestRunSummary; decisions: IngestEventDecision[] },
  generatedAt: Date,
): IngestReport {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    dryRun: run.summary.dryRun,
    summary: run.summary,
    events: run.decisions,
  };
}

export function serializeIngestReport(report: IngestReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeIngestReport(filePath: string, report: IngestReport): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeIngestReport(report), 'utf8');
}

function fieldOf<T>(resolution: Resolution<T> | undefined): FieldResolution<T> | undefined {
  if (!resolution) return undefined;
  return {
    value: resolution.value,
    method: resolution.method,
    ruleId: resolution.ruleId,
  };
}
