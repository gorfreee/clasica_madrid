import type { AccessMode, Era, EventKind, Format } from '../../lib/schemas/taxonomies.ts';
import type { Eligibility } from './golden-case.ts';

export type ResolutionMethod = 'rule' | 'knowledge' | 'fallback';

/**
 * Internal pipeline evidence. Not part of the canonical Event schema.
 * Serializable for logs and golden evaluation.
 */
export type Resolution<T> = {
  value: T;
  method: ResolutionMethod;
  ruleId: string;
  evidence: string[];
};

export type ClassificationResult = {
  eligibility: Resolution<Eligibility>;
  formats?: Resolution<Format[]>;
  eras?: Resolution<Era[]>;
  kind?: Resolution<EventKind>;
  access?: Resolution<AccessMode>;
};
