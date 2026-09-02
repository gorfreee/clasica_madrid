import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities } from '../html.ts';
import type { RawOccurrence } from '../types.ts';

const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_GROUP = new RegExp(`(\\d{1,2}(?:\\s*(?:,\\s*(?:y\\s+)?|y\\s+)\\d{1,2})*)\\s+(?:de\\s+)?(${MONTHS})(?:\\s+(?:de\\s+)?(\\d{4}))?`, 'gi');
const DAYS_ONLY = /^(\d{1,2}(?:\s*(?:,\s*(?:y\s+)?|y\s+)\d{1,2})*)\s*\.?\s*$/;
const CLOCK = /\b\d{1,2}:\d{2}(?!\d)/g;

/** Only enumerated civil dates and explicit times; never expand prose ranges. */
export function parseZarzuelaSchedule(html: string): RawOccurrence[] {
  const text = decodeHtmlEntities(html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  // Accessibility visits, durations and school links are not performances.
  // Month/year on that later line may still complete a days-only list above it.
  const monthYear = uniqueExplicitMonthYear(text);
  const schedule = text.split(/FUNCI[ÓO]N DE TEATRO ACCESIBLE|Duraci[óo]n\s*(?:\(|:)|Este espect[áa]culo cuenta/i)[0]!;
  const pending: string[] = [];
  const result: RawOccurrence[] = [];
  for (const line of schedule.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    pending.push(line);
    if (line.search(CLOCK) < 0) continue;
    const block = pending.join(' ');
    const firstTime = block.search(CLOCK);
    const dates = parseDates(block.slice(0, firstTime), monthYear);
    const timeText = block.slice(firstTime);
    const sunday = /\(domingos?\s*,?\s*(?:a las\s+)?(\d{1,2}:\d{2})\s*(?:horas|h\.?)(?:\s*)\)/i.exec(timeText);
    const general = sunday ? timeText.replace(sunday[0], '') : timeText;
    const times = [...general.matchAll(CLOCK)].map((m) => parseObservedTime(m[0]));
    const rest = general.replace(CLOCK, '')
      .replace(/horas|h\b/gi, '')
      .replace(/funciones?\s+escolares/gi, '')
      .replace(/[\s.,;:·()y-]/gi, '');
    const sundayTime = sunday ? parseObservedTime(sunday[1]!) : undefined;
    if (rest || !times.length || times.some((t) => !t) || (sunday && !sundayTime)) {
      throw new Error('teatro-zarzuela: horario no interpretable sin inferencias');
    }
    for (const date of dates) {
      const applicable = sundayTime && new Date(`${date}T12:00:00Z`).getUTCDay() === 0 ? [sundayTime] : times;
      for (const time of applicable) result.push({ raw: block, date, time: time! });
    }
    pending.length = 0;
  }
  if (!result.length) throw new Error('teatro-zarzuela: fechas u horas ausentes o ambiguas');
  if (pending.length && leftoverLooksLikeSchedule(pending.join(' '))) {
    throw new Error('teatro-zarzuela: fechas u horas ausentes o ambiguas');
  }
  const unique = new Map(result.map((o) => [`${o.date}T${o.time}`, o]));
  return [...unique.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

function parseDates(text: string, fallback?: { monthName: string; year: number }): string[] {
  const groups = [...text.matchAll(DATE_GROUP)];
  if (!groups.length && fallback) {
    const daysOnly = DAYS_ONLY.exec(text.trim());
    if (daysOnly) {
      return datedDays(daysOnly[1]!, fallback.monthName, fallback.year, text);
    }
  }
  const rest = text.replace(DATE_GROUP, '')
    .replace(/lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|sesi[oó]n doble cada ma[nñ]ana/gi, '')
    .replace(/funciones?\s+escolares/gi, '')
    .replace(/[\s,;.·()y:-]/gi, '');
  if (rest || !groups.length) throw new Error('teatro-zarzuela: fechas no enumeradas o estructura inesperada');
  let year: number | undefined;
  let nextMonth: number | undefined;
  const dates: string[] = [];
  for (const group of groups.reverse()) {
    const month = parseSpanishCalendarDate(`1 de ${group[2]} de 2000`)!.slice(5, 7);
    if (group[3]) year = Number(group[3]);
    else if (year && nextMonth !== undefined && Number(month) > nextMonth) year -= 1;
    if (!year) throw new Error('teatro-zarzuela: falta el año explícito del calendario');
    dates.push(...datedDays(group[1]!, group[2]!, year, text));
    nextMonth = Number(month);
  }
  return dates;
}

function datedDays(dayList: string, monthName: string, year: number, weekdaySource: string): string[] {
  const dates: string[] = [];
  for (const day of dayList.match(/\d+/g)!) {
    const date = parseSpanishCalendarDate(`${day} de ${monthName} de ${year}`);
    if (!date) throw new Error('teatro-zarzuela: fecha imposible en la ficha');
    dates.push(date);
  }
  const weekday = /\b(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/i.exec(weekdaySource)?.[1]
    ?.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (weekday && dates.length === 1) {
    const actual = new Date(`${dates[0]}T12:00:00Z`).getUTCDay();
    if (['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'][actual] !== weekday) {
      throw new Error('teatro-zarzuela: fecha incompatible con el día de la semana publicado');
    }
  }
  return dates;
}

/** Venue notes or "5º y 6º de Primaria" after a parsed clock line are not a schedule. */
function leftoverLooksLikeSchedule(text: string): boolean {
  if (/\b\d{1,2}:\d{2}(?!\d)/.test(text)) return true;
  if (new RegExp(DATE_GROUP.source, 'i').test(text)) return true;
  return Boolean(DAYS_ONLY.exec(text.trim()));
}

/**
 * One month+year published in the Fechas y Horarios block, including the
 * accessible-function line. Several distinct months or years are not a hint.
 */
function uniqueExplicitMonthYear(text: string): { monthName: string; year: number } | undefined {
  const dated = [...text.matchAll(DATE_GROUP)].filter((group) => group[3]);
  if (!dated.length) return undefined;
  const months = new Set(dated.map((group) => group[2]!.toLowerCase()));
  const years = new Set(dated.map((group) => Number(group[3])));
  if (months.size !== 1 || years.size !== 1) return undefined;
  return { monthName: dated[0]![2]!, year: Number(dated[0]![3]) };
}
