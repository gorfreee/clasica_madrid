import { normalizeText } from '../lib/domain/normalize.ts';
import { ID_PREFIX } from '../lib/schemas/taxonomies.ts';

const MAX_SLUG = 120;
const MAX_ID = 120;

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
  const root = toSlug(base);
  if (!used.has(root)) return root;
  let n = 2;
  while (used.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`.slice(0, MAX_SLUG);
}

export function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`.slice(0, MAX_ID);
}
