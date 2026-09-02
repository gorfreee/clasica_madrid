import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { IngestWindow } from './dates.ts';
import type { NormalizedEvent } from './normalize.ts';
import {
  snapshotNormalizedFacts,
  snapshotObservedFacts,
  type DiagnosticNormalizedFacts,
  type DiagnosticObservedFacts,
  type IngestEventDecision,
  type IngestFailureInfo,
} from './report.ts';
import type { RawEvent } from './types.ts';

export const INGEST_RUN_MANIFEST_SCHEMA_VERSION = 1;
export const INGEST_JOURNAL_SCHEMA_VERSION = 1;
export const RUN_MANIFEST_FILE = 'run.json';
export const EVENT_JOURNAL_FILE = 'events.jsonl';

export type IngestRunStage =
  | 'initialization'
  | 'extraction'
  | 'classification'
  | 'reconciliation'
  | 'apply'
  | 'completed';

export type IngestRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type IngestTimedStage = Exclude<IngestRunStage, 'completed'>;
export type IngestSourcePhase = 'extraction' | 'hydration';

export type IngestSourceTiming = {
  extractionMs: number;
  hydrationMs: number;
  totalMs: number;
  extractedEvents: number;
  hydratedEvents: number;
  hydrationAttempted: number;
  hydrationSucceeded: number;
  hydrationFailed: number;
  hydrationSkippedOutsideWindow: number;
  hydrationSkippedCircuitOpen: number;
};

export type IngestTimingSummary = {
  stagesMs: Partial<Record<IngestTimedStage, number>>;
  sources: Record<string, IngestSourceTiming>;
};

export type IngestRunManifest = {
  schemaVersion: 1;
  runId?: string;
  attempt?: number;
  gitSha?: string;
  startedAt: string;
  finishedAt?: string;
  status: IngestRunStatus;
  lastStage: IngestRunStage;
  mode: 'dry-run' | 'publish';
  sources: string[];
  window: IngestWindow;
  timings?: IngestTimingSummary;
  failure?: IngestFailureInfo;
};

export type IngestJournalKind = 'observation' | 'decision' | 'source-failure';

export type IngestJournalClassification = {
  eligibility?: IngestEventDecision['eligibility'];
  formats?: IngestEventDecision['formats'];
  eras?: IngestEventDecision['eras'];
  kind?: IngestEventDecision['kind'];
  access?: IngestEventDecision['access'];
};

export type IngestJournalEntry = {
  schemaVersion: 1;
  kind: IngestJournalKind;
  sourceId: string;
  sourceUrl?: string;
  externalId?: string;
  title?: string;
  message?: string;
  hydration?: IngestEventDecision['hydration'];
  listing?: DiagnosticObservedFacts;
  observed?: DiagnosticObservedFacts;
  normalized?: DiagnosticNormalizedFacts;
  classification?: IngestJournalClassification;
  publishable?: boolean;
  candidateGenerated?: boolean;
  identity?: IngestEventDecision['identity'];
  structuralSkip?: IngestEventDecision['structuralSkip'];
  fieldDiffs?: string[];
  classificationDrift?: IngestEventDecision['classificationDrift'];
  mergeDiagnostics?: string[];
  candidate?: IngestEventDecision['candidate'];
  aiAttempted?: boolean;
  ai?: IngestEventDecision['ai'];
};

export type FailureContext = {
  stage: IngestRunStage;
  sourceId?: string;
  sourceUrl?: string;
};

const SECRET_ENV_KEYS = [
  'GEMINI_API_KEY',
  'INGESTION_BOT_TOKEN',
  'INGEST_FETCH_RELAY_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
] as const;

const MAX_FAILURE_MESSAGE = 2000;

function journalClassification(decision: IngestEventDecision): IngestJournalClassification | undefined {
  if (!decision.eligibility && !decision.formats && !decision.eras && !decision.kind && !decision.access) {
    return undefined;
  }
  return {
    ...(decision.eligibility ? { eligibility: decision.eligibility } : {}),
    ...(decision.formats ? { formats: decision.formats } : {}),
    ...(decision.eras ? { eras: decision.eras } : {}),
    ...(decision.kind ? { kind: decision.kind } : {}),
    ...(decision.access ? { access: decision.access } : {}),
  };
}

export type ObservabilityOptions = {
  directory: string;
  mode: 'dry-run' | 'publish';
  sources: string[];
  window: IngestWindow;
  runId?: string;
  attempt?: number;
  gitSha?: string;
  now?: () => Date;
  monotonicNow?: () => number;
};

/**
 * Best-effort run observability. Writes never throw into the pipeline and
 * never touch `data/**`. SIGKILL is not interceptable; this only covers
 * graceful SIGINT/SIGTERM and process-lifetime failures.
 */
export class IngestObservability {
  readonly directory: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private manifest: IngestRunManifest;
  private stageStartedAtMs: number;
  private journalFd?: number;
  private closed = false;

  constructor(options: ObservabilityOptions) {
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.stageStartedAtMs = this.monotonicNow();
    this.manifest = {
      schemaVersion: INGEST_RUN_MANIFEST_SCHEMA_VERSION,
      startedAt: this.now().toISOString(),
      status: 'running',
      lastStage: 'initialization',
      mode: options.mode,
      sources: options.sources,
      window: options.window,
      timings: { stagesMs: {}, sources: {} },
    };
    if (options.runId) this.manifest.runId = options.runId;
    if (options.attempt !== undefined) this.manifest.attempt = options.attempt;
    if (options.gitSha) this.manifest.gitSha = options.gitSha;
    mkdirSync(this.directory, { recursive: true });
    this.journalFd = openSync(path.join(this.directory, EVENT_JOURNAL_FILE), 'a');
    this.persistManifest();
  }

  snapshot(): IngestRunManifest {
    return structuredClone(this.manifest);
  }

  setStage(stage: IngestRunStage): void {
    this.guard(() => {
      if (this.manifest.status !== 'running' || this.manifest.lastStage === stage) return;
      this.finishCurrentStageTiming();
      this.manifest.lastStage = stage;
      this.persistManifest();
    });
  }

  async measureSourcePhase<T>(sourceId: string, phase: IngestSourcePhase, task: () => Promise<T>): Promise<T> {
    if (this.closed) return task();
    const startedAtMs = this.monotonicNow();
    try {
      return await task();
    } finally {
      const durationMs = elapsedMs(startedAtMs, this.monotonicNow());
      this.guard(() => {
        const timing = this.sourceTiming(sourceId);
        if (phase === 'extraction') timing.extractionMs += durationMs;
        else timing.hydrationMs += durationMs;
        timing.totalMs = timing.extractionMs + timing.hydrationMs;
        this.persistManifest();
      });
    }
  }

  recordSourceStats(input: {
    sourceId: string;
    extractedEvents: number;
    hydratedEvents: number;
    hydrationAttempted: number;
    hydrationSucceeded: number;
    hydrationFailed: number;
    hydrationSkippedOutsideWindow?: number;
    hydrationSkippedCircuitOpen?: number;
  }): void {
    this.guard(() => {
      const timing = this.sourceTiming(input.sourceId);
      timing.extractedEvents = input.extractedEvents;
      timing.hydratedEvents = input.hydratedEvents;
      timing.hydrationAttempted = input.hydrationAttempted;
      timing.hydrationSucceeded = input.hydrationSucceeded;
      timing.hydrationFailed = input.hydrationFailed;
      timing.hydrationSkippedOutsideWindow = input.hydrationSkippedOutsideWindow ?? 0;
      timing.hydrationSkippedCircuitOpen = input.hydrationSkippedCircuitOpen ?? 0;
      this.persistManifest();
    });
  }

  recordObservation(input: {
    raw: RawEvent;
    listing?: RawEvent;
    normalized?: NormalizedEvent;
  }): void {
    this.guard(() => {
      const hydration = input.raw.hydration ?? { status: 'not-requested' as const };
      const entry: IngestJournalEntry = {
        schemaVersion: INGEST_JOURNAL_SCHEMA_VERSION,
        kind: 'observation',
        sourceId: input.raw.sourceId,
        sourceUrl: input.raw.sourceUrl,
        title: input.normalized?.title || input.raw.observed.title,
        hydration: { ...hydration },
        observed: snapshotObservedFacts(input.raw),
      };
      if (input.raw.externalId) entry.externalId = input.raw.externalId;
      if (input.listing && hydration.status === 'succeeded') {
        entry.listing = snapshotObservedFacts(input.listing);
      }
      if (input.normalized) entry.normalized = snapshotNormalizedFacts(input.normalized);
      this.append(entry);
    });
  }

  recordDecision(decision: IngestEventDecision): void {
    this.guard(() => {
      const entry: IngestJournalEntry = {
        schemaVersion: INGEST_JOURNAL_SCHEMA_VERSION,
        kind: 'decision',
        sourceId: decision.sourceId,
        sourceUrl: decision.sourceUrl,
        title: decision.title,
        publishable: decision.publishable,
        candidateGenerated: decision.candidateGenerated,
        aiAttempted: decision.aiAttempted,
      };
      if (decision.externalId) entry.externalId = decision.externalId;
      const classification = journalClassification(decision);
      if (classification) entry.classification = classification;
      if (decision.identity) entry.identity = decision.identity;
      if (decision.structuralSkip) entry.structuralSkip = decision.structuralSkip;
      if (decision.fieldDiffs && decision.fieldDiffs.length > 0) entry.fieldDiffs = decision.fieldDiffs;
      if (decision.classificationDrift) entry.classificationDrift = decision.classificationDrift;
      if (decision.mergeDiagnostics && decision.mergeDiagnostics.length > 0) {
        entry.mergeDiagnostics = decision.mergeDiagnostics;
      }
      if (decision.candidate) entry.candidate = decision.candidate;
      if (decision.ai) entry.ai = decision.ai;
      this.append(entry);
    });
  }

  recordSourceFailure(sourceId: string, message: string): void {
    this.guard(() => {
      this.append({
        schemaVersion: INGEST_JOURNAL_SCHEMA_VERSION,
        kind: 'source-failure',
        sourceId,
        message: sanitizeErrorMessage(message),
      });
    });
  }

  complete(): void {
    this.guard(() => {
      if (this.manifest.status !== 'running') return;
      this.finishCurrentStageTiming();
      this.manifest.status = 'completed';
      this.manifest.lastStage = 'completed';
      this.manifest.finishedAt = this.now().toISOString();
      this.persistManifest();
      this.flush();
    });
  }

  fail(failure: IngestFailureInfo): void {
    this.guard(() => {
      if (this.manifest.status !== 'running') return;
      this.finishCurrentStageTiming();
      this.manifest.status = 'failed';
      this.manifest.finishedAt = this.now().toISOString();
      if (failure.stage) this.manifest.lastStage = failure.stage as IngestRunStage;
      this.manifest.failure = sanitizeFailure(failure);
      this.persistManifest();
      this.flush();
    });
  }

  interrupt(signal: NodeJS.Signals): void {
    this.guard(() => {
      if (this.manifest.status !== 'running') return;
      this.finishCurrentStageTiming();
      this.manifest.status = 'interrupted';
      this.manifest.finishedAt = this.now().toISOString();
      this.manifest.failure = sanitizeFailure({
        code: 'interrupted',
        message: `Recibida ${signal}`,
        stage: this.manifest.lastStage,
      });
      this.persistManifest();
      this.flush();
    });
  }

  close(): void {
    this.guard(() => {
      this.flush();
      if (this.journalFd !== undefined) {
        closeSync(this.journalFd);
        this.journalFd = undefined;
      }
      this.closed = true;
    });
  }

  private sourceTiming(sourceId: string): IngestSourceTiming {
    const timings = this.manifest.timings ??= { stagesMs: {}, sources: {} };
    return timings.sources[sourceId] ??= {
      extractionMs: 0,
      hydrationMs: 0,
      totalMs: 0,
      extractedEvents: 0,
      hydratedEvents: 0,
      hydrationAttempted: 0,
      hydrationSucceeded: 0,
      hydrationFailed: 0,
      hydrationSkippedOutsideWindow: 0,
      hydrationSkippedCircuitOpen: 0,
    };
  }

  private finishCurrentStageTiming(): void {
    const stage = this.manifest.lastStage;
    const finishedAtMs = this.monotonicNow();
    if (stage !== 'completed') {
      const timings = this.manifest.timings ??= { stagesMs: {}, sources: {} };
      timings.stagesMs[stage] = (timings.stagesMs[stage] ?? 0) + elapsedMs(this.stageStartedAtMs, finishedAtMs);
    }
    this.stageStartedAtMs = finishedAtMs;
  }

  private append(entry: IngestJournalEntry): void {
    if (this.journalFd === undefined) return;
    writeSync(this.journalFd, Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'));
  }

  private persistManifest(): void {
    writeFileSync(
      path.join(this.directory, RUN_MANIFEST_FILE),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
      'utf8',
    );
  }

  private flush(): void {
    if (this.journalFd === undefined) return;
    fsyncSync(this.journalFd);
  }

  private guard(fn: () => void): void {
    if (this.closed) return;
    try {
      fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Observabilidad de ingestión: ${sanitizeErrorMessage(message)}`);
    }
  }
}

function elapsedMs(startedAtMs: number, finishedAtMs: number): number {
  return Math.max(0, Math.round(finishedAtMs - startedAtMs));
}

export function startObservability(options: ObservabilityOptions): IngestObservability | undefined {
  try {
    return new IngestObservability(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`No se pudo iniciar la observabilidad de ingestión: ${sanitizeErrorMessage(message)}`);
    return undefined;
  }
}

export function parseGithubAttempt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function attachFailureContext(error: unknown, context: FailureContext): never {
  const err = error instanceof Error ? error : new Error(String(error));
  Object.assign(err, context);
  throw err;
}

export function readFailureContext(error: unknown): FailureContext | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if (!('stage' in error)) return undefined;
  const stage = (error as { stage?: unknown }).stage;
  if (typeof stage !== 'string') return undefined;
  const sourceId = 'sourceId' in error && typeof error.sourceId === 'string' ? error.sourceId : undefined;
  const sourceUrl = 'sourceUrl' in error && typeof error.sourceUrl === 'string' ? error.sourceUrl : undefined;
  return {
    stage: stage as IngestRunStage,
    ...(sourceId ? { sourceId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

export function classifyFailureCode(message: string): string {
  if (/GEMINI_|requieren el provider Gemini/.test(message)) return 'ai-config-fatal';
  return 'unexpected-exception';
}

export function sanitizeFailure(failure: IngestFailureInfo): IngestFailureInfo {
  const sanitized: IngestFailureInfo = {
    code: failure.code,
    message: sanitizeErrorMessage(failure.message),
  };
  if (failure.stage) sanitized.stage = failure.stage;
  if (failure.sourceId) sanitized.sourceId = failure.sourceId;
  if (failure.sourceUrl) sanitized.sourceUrl = failure.sourceUrl;
  return sanitized;
}

export function sanitizeErrorMessage(message: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = message;
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (value && value.length >= 8) result = result.split(value).join(`[${key}]`);
  }
  result = result.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  result = result.replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, '$1[redacted]');
  if (result.length <= MAX_FAILURE_MESSAGE) return result;
  return `${result.slice(0, MAX_FAILURE_MESSAGE)}…[truncated]`;
}

export function resolveObservabilityDir(reportPath?: string, observabilityDir?: string): string | undefined {
  if (observabilityDir) return observabilityDir;
  if (reportPath) return path.dirname(reportPath);
  return undefined;
}
