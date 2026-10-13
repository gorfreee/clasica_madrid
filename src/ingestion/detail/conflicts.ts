/** Source facts that disagree. Diagnostic only; never sent to classification or the published catalogue. */
export type HydrationDiscrepancy = {
  field: 'identity' | 'date' | 'time' | 'venue';
  evidence: Array<{ surface: string; value: string }>;
  resolution: 'withheld' | 'detail-preferred';
};

export class HydrationConflictError extends Error {
  constructor(message: string, public readonly discrepancies: HydrationDiscrepancy[]) {
    super(message);
    this.name = 'HydrationConflictError';
  }
}

export function sourceConflict(
  message: string,
  field: HydrationDiscrepancy['field'],
  evidence: HydrationDiscrepancy['evidence'],
): HydrationConflictError {
  return new HydrationConflictError(message, [{ field, evidence, resolution: 'withheld' }]);
}
