import type { IngestWindow } from './dates.ts';
import type { SourceTemporalCoverage } from './types.ts';

/** Bounds come from official calendar configuration/season, never last event. */
export function publishedIntervalCoverage(
  interval: IngestWindow,
  window: IngestWindow,
  evidence: string,
): SourceTemporalCoverage {
  const status = interval.to < window.from ? 'stale'
    : interval.from <= window.from && interval.to >= window.to ? 'complete' : 'partial';
  return { status, interval, evidence };
}

export function temporalCoverageLabel(coverage: SourceTemporalCoverage | undefined): string {
  if (!coverage) return 'no declarada (contrato legacy)';
  return coverage.status === 'unknown' ? 'unknown'
    : `${coverage.status}: ${coverage.interval.from} → ${coverage.interval.to}`;
}
