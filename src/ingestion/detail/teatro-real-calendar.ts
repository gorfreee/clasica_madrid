import { normalizeText } from '../../lib/domain/normalize.ts';
import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { stripTags } from '../html.ts';
import type { ObservedFactPatch } from '../observed.ts';
import { sourceConflict } from './conflicts.ts';

/** A performance change. The adverb "adelante" ("mirando hacia adelante") is not one. */
const scheduleModification = /\b(?:adelant(?!e\b)|reprogram|previst[ao]s?\s+inicialmente)/iu;
const advanceStem = /\badelant(?!e\b)/iu;

/** Teatro Real's singular advance notice, interpreted against its functions table.
 * Deliberately source-specific: this is not another generic postponement rule.
 * The strict parser starts only for real modification wording; an ambiguous notice is still withheld. */
export function teatroRealCalendar(html: string, intro: string): ObservedFactPatch {
  const notices = [...intro.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => stripTags(m[1]!)).filter(p => scheduleModification.test(p));
  if (!notices.length) return {};
  const block = /<section\b[^>]*class="functions-show"[^>]*>([\s\S]*?)<\/section>/i.exec(html)?.[1];
  const fail = (message: string): never => { throw sourceConflict(message, 'date', [
    { surface: 'detail:advance-notice', value: notices.join('\n') },
    { surface: 'detail:functions-show', value: stripTags(block ?? '') },
  ]); };
  if (!block) return fail('adelanto sin calendario completo de funciones');
  const dates = [...block.matchAll(/class="functions-show__block--item-date"[^>]*>\s*<p>([\s\S]*?)<\/p>[\s\S]*?class="functions-show__block--item-hour"[^>]*>\s*<p>([\s\S]*?)<\/p>/gi)];
  if (!dates.length || dates.length !== [...block.matchAll(/class="functions-show__block--item-date"/g)].length) return fail('calendario de funciones incompleto');
  const occurrences = dates.map(m => {
    const raw = stripTags(m[1]!);
    const date = parseSpanishCalendarDate(raw.replace(/^(\d+)\s+/, '$1 de '));
    const time = parseObservedTime(stripTags(m[2]!));
    if (!date || !time) return fail('fecha u hora de función no reconocible');
    return { raw: `${raw} ${time}`, date, time };
  });
  const unique = [...new Map(occurrences.map(s => [`${s.date}|${s.time}`, s])).values()];
  const matching = notices.filter(p => advanceStem.test(p));
  if (matching.length !== 1) return fail('aviso de adelanto incompleto o múltiple');
  const sentence = matching[0]!.split(/\.\s/)[0]!.trim();
  const match = /^La representación de (.+?) prevista inicialmente para el (\d{1,2} de [a-záéíóú]+(?: de \d{4})?) se adelantará al (\d{1,2} de [a-záéíóú]+(?: de \d{4})?) a las (\d{1,2}:\d{2})\s*h\.?$/iu.exec(sentence);
  const title = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  if (!match || normalizeText(match[1]!) !== normalizeText(title) ||
      [...matching[0]!.matchAll(new RegExp(advanceStem.source, 'giu'))].length !== 1 || notices.some(p => p !== matching[0])) return fail('aviso sin correspondencia singular inequívoca');
  const dated = (text: string) => {
    if (/\d{4}/.test(text)) return parseSpanishCalendarDate(text);
    const years = [...new Set(unique.map(s => s.date.slice(0, 4)))];
    const candidates = years.map(y => parseSpanishCalendarDate(`${text} de ${y}`)).filter((d): d is string => Boolean(d))
      .filter(d => unique.some(s => s.date.slice(0, 7) === d.slice(0, 7)));
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const from = dated(match[2]!), to = dated(match[3]!), time = parseObservedTime(match[4]!);
  if (!from || !to || !time || to >= from) return fail('origen o destino del adelanto ambiguo');
  const old = unique.filter(s => s.date === from), target = unique.filter(s => s.date === to);
  if (old.length > 1 || target.length > 1 || (!old.length && !target.length) || target.some(s => s.time !== time)) {
    return fail('adelanto incompatible con el calendario de funciones');
  }
  const corrected = [...unique.filter(s => s.date !== from && s.date !== to), { raw: matching[0]!, date: to, time }]
    .sort((a, b) => `${a.date}|${a.time}`.localeCompare(`${b.date}|${b.time}`));
  return { occurrences: corrected, calendarEvidence: {
    // Only the explicit change retires the old session; no absence-based deletion
    // is needed for this source even though the entire table is read and retained.
    changes: [{ from: { date: from }, to: { date: to, time } }], evidence: matching[0]!,
  } };
}
