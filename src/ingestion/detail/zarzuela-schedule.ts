import { addIsoDays, parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities } from '../html.ts';
import type { RawOccurrence } from '../types.ts';
import { zarzuelaListingBounds } from './zarzuela-hydration.ts';

const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_GROUP = new RegExp(`(\\d{1,2}(?:\\s*(?:,\\s*(?:y\\s+)?|y\\s+)\\d{1,2})*)\\s+(?:de\\s+)?(${MONTHS})(?:\\s+(?:de\\s+)?(\\d{4}))?`, 'gi');
const RANGE = new RegExp(
  `\\bdel\\s+(\\d{1,2})(?:\\s+de\\s+(${MONTHS}))?(?:\\s+de\\s+(\\d{4}))?\\s+al\\s+(\\d{1,2})(?:\\s+de\\s+(${MONTHS}))?(?:\\s+de\\s+(\\d{4}))?`,
  'gi',
);
const DAYS_ONLY = /^(\d{1,2}(?:\s*(?:,\s*(?:y\s+)?|y\s+)\d{1,2})*)\s*\.?\s*$/;
const CLOCK = /\b\d{1,2}:\d{2}(?!\d)/g;
const HAS_CLOCK = /\b\d{1,2}:\d{2}(?!\d)/;
const VENUE_LINE = /^\s*EN (?:LA|EL)\b/i;
const CLAUSE_SPLIT = /(?<=\d{1,2}:\d{2}(?:\s*horas)?\)?)\s*[,;]\s*(?=(?:del\s+\d|\d{1,2}\s+de\s+))/i;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'] as const;
const MAX_RANGE_DAYS = 21;
const MONTH_TYPO_MAX_DAYS = 40;

export type ZarzuelaScheduleOptions = {
  /** Same ficha: intro lines that may carry the year or the clock missing from Fechas y Horarios. */
  hintHtml?: string;
  /** Listing date, only to resolve a self-contradictory weekday on an otherwise explicit ficha date. */
  listingDateText?: string;
};

type YearHint = (monthName: string) => number | undefined;

type ScheduleContext = {
  yearForMonth: YearHint;
  fallbackMonthYear?: { monthName: string; year: number };
  listingDateText?: string;
};

/** Enumerated dates, explicit ficha ranges with times, never listing-range fabrication. */
export function parseZarzuelaSchedule(html: string, options: ZarzuelaScheduleOptions = {}): RawOccurrence[] {
  const primaryRaw = decodeScheduleHtml(html);
  const hintRaw = options.hintHtml ? decodeScheduleHtml(options.hintHtml) : '';
  const primary = performanceSchedule(primaryRaw);
  const hint = scheduleLikeText(performanceSchedule(hintRaw));
  const ctx: ScheduleContext = {
    yearForMonth: monthYearHint(`${primaryRaw}\n${hintRaw}`),
    fallbackMonthYear: uniqueExplicitMonthYear(primaryRaw),
    listingDateText: options.listingDateText,
  };
  const source = HAS_CLOCK.test(primary) ? primary : HAS_CLOCK.test(hint) ? hint : primary;
  return parseScheduleText(source, ctx);
}

function parseScheduleText(text: string, ctx: ScheduleContext): RawOccurrence[] {
  CLOCK.lastIndex = 0;
  const pending: string[] = [];
  const result: RawOccurrence[] = [];
  for (const line of scheduleLines(text)) {
    CLOCK.lastIndex = 0;
    pending.push(line);
    if (line.search(CLOCK) < 0) continue;
    const block = pending.join(' ');
    CLOCK.lastIndex = 0;
    const firstTime = block.search(CLOCK);
    CLOCK.lastIndex = 0;
    const dates = parseDates(block.slice(0, firstTime), ctx);
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

function parseDates(text: string, ctx: ScheduleContext): string[] {
  const dates: string[] = [];
  let rest = text;
  RANGE.lastIndex = 0;
  for (const match of text.matchAll(new RegExp(RANGE.source, 'gi'))) {
    dates.push(...expandRange(match, ctx, text));
    rest = rest.replace(match[0]!, ' ');
  }
  dates.push(...parseEnumeratedDates(rest, ctx, text));
  if (!dates.length) throw new Error('teatro-zarzuela: fechas no enumeradas o estructura inesperada');
  return dates;
}

function parseEnumeratedDates(text: string, ctx: ScheduleContext, weekdaySource: string): string[] {
  DATE_GROUP.lastIndex = 0;
  const groups = [...text.matchAll(DATE_GROUP)];
  DATE_GROUP.lastIndex = 0;
  if (!groups.length) {
    const daysOnly = DAYS_ONLY.exec(text.trim());
    if (daysOnly && ctx.fallbackMonthYear) {
      return datedDays(
        daysOnly[1]!,
        ctx.fallbackMonthYear.monthName,
        ctx.fallbackMonthYear.year,
        weekdaySource,
        ctx.listingDateText,
      );
    }
    const leftover = stripDateNoise(text);
    if (leftover) throw new Error('teatro-zarzuela: fechas no enumeradas o estructura inesperada');
    return [];
  }
  const leftover = stripDateNoise(text.replace(DATE_GROUP, ''));
  if (leftover) throw new Error('teatro-zarzuela: fechas no enumeradas o estructura inesperada');
  let year: number | undefined;
  let nextMonth: number | undefined;
  const dates: string[] = [];
  for (const group of groups.reverse()) {
    const month = parseSpanishCalendarDate(`1 de ${group[2]} de 2000`)!.slice(5, 7);
    if (group[3]) year = Number(group[3]);
    else if (year && nextMonth !== undefined && Number(month) > nextMonth) year -= 1;
    if (!year) year = ctx.yearForMonth(group[2]!);
    if (!year) throw new Error('teatro-zarzuela: falta el año explícito del calendario');
    dates.push(...datedDays(group[1]!, group[2]!, year, weekdaySource, ctx.listingDateText));
    nextMonth = Number(month);
  }
  return dates;
}

function expandRange(match: RegExpMatchArray, ctx: ScheduleContext, weekdaySource: string): string[] {
  const fromDay = Number(match[1]);
  const toDay = Number(match[4]);
  const toMonthName = match[5] ?? match[2];
  const fromMonthName = match[2] ?? toMonthName;
  if (!fromMonthName || !toMonthName) {
    throw new Error('teatro-zarzuela: rango de fechas incompleto');
  }
  let toYear = match[6] ? Number(match[6]) : ctx.yearForMonth(toMonthName);
  let fromYear = match[3] ? Number(match[3]) : undefined;
  const fromMonth = Number(parseSpanishCalendarDate(`1 de ${fromMonthName} de 2000`)!.slice(5, 7));
  const toMonth = Number(parseSpanishCalendarDate(`1 de ${toMonthName} de 2000`)!.slice(5, 7));
  if (!fromYear && toYear !== undefined) {
    // Do not guess a missing year across New Year.
    if (fromMonth > toMonth) throw new Error('teatro-zarzuela: falta el año explícito del calendario');
    fromYear = toYear;
  }
  if (!toYear && fromYear !== undefined) {
    if (toMonth < fromMonth) throw new Error('teatro-zarzuela: falta el año explícito del calendario');
    toYear = fromYear;
  }
  if (!fromYear || !toYear) throw new Error('teatro-zarzuela: falta el año explícito del calendario');
  const from = parseSpanishCalendarDate(`${fromDay} de ${fromMonthName} de ${fromYear}`);
  const to = parseSpanishCalendarDate(`${toDay} de ${toMonthName} de ${toYear}`);
  if (!from || !to || from > to) throw new Error('teatro-zarzuela: rango de fechas imposible');
  const dates: string[] = [];
  for (let date = from; date <= to; date = addIsoDays(date, 1)) {
    dates.push(date);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new Error('teatro-zarzuela: rango demasiado amplio para expandir');
    }
  }
  if (dates.length === 1) {
    return datedDays(String(fromDay), fromMonthName, fromYear, weekdaySource, ctx.listingDateText);
  }
  return dates;
}

function datedDays(
  dayList: string,
  monthName: string,
  year: number,
  weekdaySource: string,
  listingDateText?: string,
): string[] {
  const dates: string[] = [];
  for (const day of dayList.match(/\d+/g)!) {
    const date = parseSpanishCalendarDate(`${day} de ${monthName} de ${year}`);
    if (!date) throw new Error('teatro-zarzuela: fecha imposible en la ficha');
    dates.push(date);
  }
  const weekday = /\b(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/i.exec(weekdaySource)?.[1]
    ?.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (weekday && dates.length === 1) {
    const actual = WEEKDAYS[new Date(`${dates[0]}T12:00:00Z`).getUTCDay()];
    if (actual !== weekday) {
      const resolved = resolveWeekdayMismatch(dates[0]!, weekday, listingDateText);
      if (!resolved) throw new Error('teatro-zarzuela: fecha incompatible con el día de la semana publicado');
      return [resolved];
    }
  }
  return dates;
}

/**
 * The ficha named a weekday that the civil date does not have. Use the listing
 * only when it is a single corroborated date (same weekday and day-of-month,
 * adjacent month typo), never a range.
 */
function resolveWeekdayMismatch(
  fichaDate: string,
  weekday: string,
  listingDateText: string | undefined,
): string | undefined {
  const bounds = zarzuelaListingBounds(listingDateText);
  if (!bounds || bounds.from !== bounds.to) return undefined;
  const listingDate = bounds.from;
  if (listingDate.slice(8, 10) !== fichaDate.slice(8, 10)) return undefined;
  if (WEEKDAYS[new Date(`${listingDate}T12:00:00Z`).getUTCDay()] !== weekday) return undefined;
  const delta = Math.abs(Date.parse(`${listingDate}T12:00:00Z`) - Date.parse(`${fichaDate}T12:00:00Z`)) / 86_400_000;
  if (delta === 0 || delta > MONTH_TYPO_MAX_DAYS) return undefined;
  return listingDate;
}

function leftoverLooksLikeSchedule(text: string): boolean {
  if (/\b\d{1,2}:\d{2}(?!\d)/.test(text)) return true;
  if (new RegExp(DATE_GROUP.source, 'i').test(text)) return true;
  return Boolean(DAYS_ONLY.exec(text.trim()));
}

function decodeScheduleHtml(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<br\s*\/?>|<\/p>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function performanceSchedule(text: string): string {
  const schedule = text.split(
    /FUNCI[ÓO]N DE TEATRO ACCESIBLE|Duraci[óo]n\s*(?:aproximada\s*)?(?:\(|:)|Este espect[áa]culo cuenta|El formulario de reserva|RESERVAS PARA CENTROS/i,
  )[0]!;
  return schedule
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !VENUE_LINE.test(line))
    .join('\n');
}

function scheduleLikeText(text: string): string {
  DATE_GROUP.lastIndex = 0;
  RANGE.lastIndex = 0;
  return scheduleLines(text)
    .filter((line) => {
      DATE_GROUP.lastIndex = 0;
      RANGE.lastIndex = 0;
      return HAS_CLOCK.test(line)
        || DATE_GROUP.test(line)
        || RANGE.test(line)
        || Boolean(DAYS_ONLY.exec(line));
    })
    .join('\n');
}

function scheduleLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    lines.push(...line.split(CLAUSE_SPLIT).map((part) => part.trim()).filter(Boolean));
  }
  return lines;
}

function monthYearHint(text: string): YearHint {
  const yearsByMonth = new Map<string, Set<number>>();
  const add = (monthName: string | undefined, year: string | undefined) => {
    if (!monthName || !year) return;
    const key = monthName.toLowerCase();
    const years = yearsByMonth.get(key) ?? new Set<number>();
    years.add(Number(year));
    yearsByMonth.set(key, years);
  };
  for (const group of text.matchAll(DATE_GROUP)) add(group[2], group[3]);
  for (const range of text.matchAll(RANGE)) {
    add(range[2], range[3]);
    add(range[5], range[6]);
  }
  return (monthName: string) => {
    const years = yearsByMonth.get(monthName.toLowerCase());
    if (!years || years.size !== 1) return undefined;
    return [...years][0];
  };
}

function stripDateNoise(text: string): string {
  return text
    .replace(/lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|sesi[oó]n doble cada ma[nñ]ana/gi, '')
    .replace(/funciones?\s+escolares/gi, '')
    .replace(/[\s,;.·()y:-]/gi, '');
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
