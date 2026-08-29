import type { AccessMode } from '../../lib/schemas/taxonomies.ts';
import { collapseWhitespace } from '../html.ts';
import { foldText } from './text.ts';
import type { Resolution } from './types.ts';

const FREE_LITERALS = new Set(['1', 'true', 'free', 'gratis']);
const PAID_LITERALS = new Set(['0', 'false', 'paid']);

/**
 * Resolve access only from observed `accessText`.
 * Venue, source and defaultAccess must not be used.
 */
export function resolveAccess(accessText: string | undefined): Resolution<AccessMode> {
  if (!accessText) {
    return {
      value: 'unknown',
      method: 'fallback',
      ruleId: 'access-missing',
      evidence: [],
    };
  }
  const collapsed = collapseWhitespace(accessText);
  const text = foldText(collapsed);
  if (!text) {
    return {
      value: 'unknown',
      method: 'fallback',
      ruleId: 'access-missing',
      evidence: [],
    };
  }

  if (FREE_LITERALS.has(text) || isFreeAccess(text)) {
    return {
      value: 'free',
      method: 'rule',
      ruleId: 'access-free',
      evidence: [collapsed],
    };
  }

  if (PAID_LITERALS.has(text) || isPaidAccess(text)) {
    return {
      value: 'paid',
      method: 'rule',
      ruleId: 'access-paid',
      evidence: [collapsed],
    };
  }

  return {
    value: 'unknown',
    method: 'fallback',
    ruleId: 'access-unclear',
    evidence: [collapsed],
  };
}

function isFreeAccess(text: string): boolean {
  return (
    /\bgratis\b/.test(text) ||
    /\bgratuit[oa]s?\b/.test(text) ||
    /entrada libre/.test(text) ||
    /acceso libre/.test(text) ||
    /libre hasta completar aforo/.test(text)
  );
}

function isPaidAccess(text: string): boolean {
  if (/\bde pago\b/.test(text)) return true;
  if (/\d(?:[\s.,']\d+)*\s*€/.test(text)) return true;
  if (/\d(?:[\s.,']\d+)*\s*euros?\b/.test(text)) return true;
  if (/desde\s+\d/.test(text)) return true;
  if (/compra(?:r)?(?: tus)? entradas/.test(text)) return true;
  if (/venta de entradas/.test(text)) return true;
  if (/\bprecio(?:s| unico| única)?\b/.test(text) && /\d/.test(text)) return true;
  if (/\btickets?\b/.test(text)) return true;
  return false;
}
