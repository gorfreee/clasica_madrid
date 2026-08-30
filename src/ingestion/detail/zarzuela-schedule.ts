import { parseObservedTime, parseSpanishCalendarDate } from '../dates.ts';
import { decodeHtmlEntities } from '../html.ts';
import type { RawOccurrence } from '../types.ts';

const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_GROUP = new RegExp(`(\\d{1,2}(?:\\s*(?:,\\s*(?:y\\s+)?|y\\s+)\\d{1,2})*)\\s+(?:de\\s+)?(${MONTHS})(?:\\s+(?:de\\s+)?(\\d{4}))?`, 'gi');
const CLOCK = /\b\d{1,2}:\d{2}(?!\d)/g;

/** Only enumerated civil dates and explicit times; never expand prose ranges. */
export function parseZarzuelaSchedule(html: string): RawOccurrence[] {
  const text = decodeHtmlEntities(html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  // Accessibility visits, durations and school links are not performances.
  const schedule = text.split(/FUNCI[ÓO]N DE TEATRO ACCESIBLE|Duraci[óo]n\s*(?:\(|:)|Este espect[áa]culo cuenta/i)[0]!;
  const pending: string[] = [];
  const result: RawOccurrence[] = [];
  for (const line of schedule.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    pending.push(line);
    if (line.search(CLOCK) < 0) continue;
    const block = pending.join(' ');
    const firstTime = block.search(CLOCK);
    const dates = parseDates(block.slice(0, firstTime));
    const timeText = block.slice(firstTime);
    const sunday = /\(domingos?\s*,?\s*(?:a las\s+)?(\d{1,2}:\d{2})\s*(?:horas|h\.?)(?:\s*)\)/i.exec(timeText);
    const general = sunday ? timeText.replace(sunday[0], '') : timeText;
    const times = [...general.matchAll(CLOCK)].map((m) => parseObservedTime(m[0]));
    const rest = general.replace(CLOCK, '').replace(/horas|h\b/gi, '').replace(/[\s.,;:·()y-]/gi, '');
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
  if (pending.length || !result.length) throw new Error('teatro-zarzuela: fechas u horas ausentes o ambiguas');
  const unique = new Map(result.map((o) => [`${o.date}T${o.time}`, o]));
  return [...unique.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

function parseDates(text: string): string[] {
  const groups = [...text.matchAll(DATE_GROUP)];
  const rest = text.replace(DATE_GROUP, '')
    .replace(/lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|sesi[oó]n doble cada ma[nñ]ana/gi, '')
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
    for (const day of group[1]!.match(/\d+/g)!) {
      const date = parseSpanishCalendarDate(`${day} de ${group[2]} de ${year}`);
      if (!date) throw new Error('teatro-zarzuela: fecha imposible en la ficha');
      dates.push(date);
    }
    nextMonth = Number(month);
  }
  const weekday = /\b(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/i.exec(text)?.[1]
    ?.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (weekday && dates.length === 1) {
    const actual = new Date(`${dates[0]}T12:00:00Z`).getUTCDay();
    if (['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'][actual] !== weekday) {
      throw new Error('teatro-zarzuela: fecha incompatible con el día de la semana publicado');
    }
  }
  return dates;
}
