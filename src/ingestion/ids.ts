import { normalizeText } from '../lib/domain/normalize.ts';
import { ID_PREFIX } from '../lib/schemas/taxonomies.ts';

const MAX_SLUG = 120;
const MAX_ID = 120;
const MAX_COLLISION_ATTEMPTS = 100_000;

export function toSlug(value: string): string {
  const slug = normalizeText(value).replace(/ /g, '-');
  return slug.slice(0, MAX_SLUG) || 'evento';
}

export function toIdTail(value: string): string {
  const tail = normalizeText(value).replace(/ /g, '_');
  return tail.slice(0, MAX_ID - 4) || 'item';
}

export function makePrefixedId(prefix: string, ...parts: string[]): string {
  const tail = parts
    .map((part) => toIdTail(part))
    .filter(Boolean)
    .join('_')
    .replace(/_+/g, '_');
  const id = `${prefix}${tail}`;
  return id.length <= MAX_ID ? id : id.slice(0, MAX_ID).replace(/_+$/, '');
}

export function eventIdFor(sourceId: string, identity: string): string {
  return makePrefixedId(ID_PREFIX.event, sourceId, identity);
}

export function occurrenceIdFor(eventId: string, index: number): string {
  const n = String(index + 1).padStart(2, '0');
  const withoutPrefix = eventId.startsWith(ID_PREFIX.event)
    ? eventId.slice(ID_PREFIX.event.length)
    : eventId;
  return makePrefixedId(ID_PREFIX.occurrence, withoutPrefix, n);
}

export function venueIdFor(name: string): string {
  return makePrefixedId(ID_PREFIX.venue, name);
}

export function uniqueSlug(base: string, used: Set<string>): string {
  return uniquify(toSlug(base), used, '-', MAX_SLUG);
}

export function uniqueId(base: string, used: Set<string>): string {
  const root = base.length <= MAX_ID ? base : base.slice(0, MAX_ID).replace(/_+$/, '') || 'item';
  return uniquify(root, used, '_', MAX_ID);
}

/**
 * Resolve a collision without exceeding `max`. The numeric suffix is reserved
 * first so truncation cannot recreate a value that is already taken.
 */
function uniquify(root: string, used: Set<string>, separator: string, max: number): string {
  if (root.length <= max && !used.has(root)) return root;
  for (let n = 2; n < MAX_COLLISION_ATTEMPTS; n += 1) {
    const suffix = `${separator}${n}`;
    if (suffix.length >= max) {
      throw new Error(`no se pudo generar un identificador único dentro de ${max} caracteres`);
    }
    const candidate = `${root.slice(0, max - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`no se pudo generar un identificador único (más de ${MAX_COLLISION_ATTEMPTS} colisiones)`);
}
