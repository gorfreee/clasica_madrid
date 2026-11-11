import { collapseWhitespace } from '../html.ts';

/**
 * Keep observed access copy only when it states a price or a free-admission
 * phrase. CTA labels ("Comprar", "Entradas", "Reservar") are not evidence.
 * Classification stays in `resolveAccess` / the AI fallback.
 */
const CTA_ONLY =
  /^(?:compra(?:r)?(?:\s+la)?(?:\s+tus)?\s+entradas?|entradas?|reservar?|tickets?)$/i;
const EXPLICIT =
  /€|\beuros?\b|desde\s+\d|\bgratis\b|\bgratuit|\bentrada libre\b|\bacceso libre\b|libre hasta completar aforo/i;

export function explicitAccessText(value: string | undefined): string | undefined {
  const text = collapseWhitespace(value ?? '');
  if (!text || CTA_ONLY.test(text)) return undefined;
  if (!EXPLICIT.test(text)) return undefined;
  return text;
}
