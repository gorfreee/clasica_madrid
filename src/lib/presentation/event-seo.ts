import { compareDateTime, nextUpcomingOccurrence } from '../domain/dates.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import type { Occurrence } from '../schemas/event.ts';
import { formatLabels, seriesKindLabels } from './labels.ts';
import { isMadridMunicipality } from '../domain/normalize.ts';

/** Layout appends the brand. Unique titles retain the established scheme. */
export function eventDocumentTitle(title: string, venueName: string): string {
  return title.includes(venueName) ? title : `${title} · ${venueName}`;
}

/** Same next / last scheduled representation as the practical ficha facts. */
export function relevantOccurrence(resolved: ResolvedEvent, now: Date): Occurrence | undefined {
  const occurrences = resolved.event.occurrences;
  return nextUpcomingOccurrence(occurrences, now)
    ?? occurrences.filter((item) => item.status === 'scheduled')
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '')).at(-1)
    ?? [...occurrences].sort((a, b) => compareDateTime(a.date, a.time, b.date, b.time)).at(-1);
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', year: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

/** Only actual collisions between canonical pages receive factual qualifiers. */
export function buildEventDocumentTitles(events: readonly ResolvedEvent[], now: Date): Map<string, string> {
  const qualifiers = new Map<string, string[]>();
  const titleOf = (item: ResolvedEvent) => {
    const facts = qualifiers.get(item.event.id) ?? [];
    if (facts.length === 0) return eventDocumentTitle(item.event.title, item.rootVenue.name);
    return item.event.title.includes(item.rootVenue.name)
      ? [item.event.title, ...facts].join(' · ')
      : [item.event.title, ...facts, item.rootVenue.name].join(' · ');
  };
  const stages: ((item: ResolvedEvent) => string | undefined)[] = [
    (item) => { const occurrence = relevantOccurrence(item, now); return occurrence && shortDate(occurrence.date); },
    (item) => relevantOccurrence(item, now)?.time ?? undefined,
    (item) => item.spaceName ?? undefined,
    (item) => item.event.composers.map((composer) => composer.name).join(', '),
    (item) => item.event.works.map((work) => work.title).join('; '),
    (item) => item.event.performers.map((performer) => performer.name).join(', '),
    (item) => item.series?.name,
    (item) => [...item.event.occurrences]
      .sort((a, b) => compareDateTime(a.date, a.time, b.date, b.time))
      .map((occurrence) => `${shortDate(occurrence.date)}${occurrence.time ? ` ${occurrence.time}` : ''}`)
      .join('; '),
  ];
  for (const [stage, factOf] of stages.entries()) {
    const groups = new Map<string, ResolvedEvent[]>();
    for (const item of events) {
      const title = titleOf(item);
      groups.set(title, [...(groups.get(title) ?? []), item]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      if (stage > 0 && new Set(group.map(factOf)).size < 2) continue;
      for (const item of group) {
        const fact = factOf(item);
        if (fact) qualifiers.set(item.event.id, [...(qualifiers.get(item.event.id) ?? []), fact]);
      }
    }
  }
  // Identical public facts cannot be disambiguated honestly with technical IDs.
  return new Map(events.map((item) => [item.event.id, titleOf(item)]));
}

export const EVENT_DESCRIPTION_MAX_LENGTH = 360;

function compactText(value: string, limit: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, boundary > limit / 2 ? boundary : undefined)}…`;
}

/** Keep complete canonical names / works; do not append an invented “and more”. */
function factList(values: string[], limit: number, count: number): string {
  const selected: string[] = [];
  for (const value of [...new Set(values.map((item) => item.trim().replace(/\s+/g, ' ')))]) {
    if (!value || selected.includes(value)) continue;
    if ([...selected, value].join(', ').length > limit) continue;
    selected.push(value);
    if (selected.length === count) break;
  }
  return selected.join(', ');
}

/** Musical facts first, then works / cycle if space remains. No source prose. */
export function buildEventDescription(resolved: ResolvedEvent, occurrence?: Occurrence): string {
  const { event, rootVenue, series } = resolved;
  const date = occurrence ? new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${occurrence.date}T12:00:00Z`)) : '';
  const place = isMadridMunicipality(rootVenue.municipality)
    ? rootVenue.name : `${rootVenue.name}, ${rootVenue.municipality}`;
  const when = date ? `, ${date}${occurrence?.time ? ` a las ${occurrence.time}` : ''}` : '';
  const parts = [`${compactText(event.title, 140)} en ${compactText(place, 90)}${when}.`];
  const access = event.access === 'free' ? 'Entrada gratuita.' : event.access === 'paid' ? 'De pago.' : '';
  const format = event.formats[0] ? `${formatLabels[event.formats[0]]}.` : '';
  const tail = [format, access].filter(Boolean).join(' ');
  const remaining = () => EVENT_DESCRIPTION_MAX_LENGTH - parts.join(' ').length - tail.length - 2;
  const add = (text: string) => { if (text && text.length + 1 <= remaining()) parts.push(`${text}.`); };
  const composers = factList(event.composers.map((item) => item.name), Math.min(90, remaining()), 3);
  const performers = factList(
    event.performers.map((item) => item.name).filter((name) => !event.title.includes(name)),
    Math.min(120, remaining() - (composers ? composers.length + 2 : 0)), 3,
  );
  add(performers);
  add(composers);
  const work = factList(event.works.map((item) => item.composerName
    ? `${item.title} (${item.composerName})` : item.title), Math.min(100, remaining() - 10), 1);
  if (work) add(`Programa: ${work}`);
  if (series && !event.title.includes(series.name)) add(`${seriesKindLabels[series.kind]}: ${series.name}`);
  if (tail) parts.push(tail);
  return parts.join(' ');
}
