import { flattenHtmlBlocks, stripTags } from '../html.ts';
import { normalizeComposerList, normalizePersonList, type ObservedFactPatch, type ObservedPerson } from '../observed.ts';
import type { RawEvent } from '../types.ts';
import { inferScheduleFromText } from './schedule.ts';
import { parseZarzuelaSchedule } from './zarzuela-schedule.ts';

const ROLE = /^(?:soprano|mezzosoprano|contralto|tenor|bar[ií]tono|bajo|piano|viol[ií]n|viola|violonchelo|flauta|clave|direcci[oó]n musical(?: y clave)?)$/i;

export function parseZarzuelaDetail(_event: RawEvent, body: string): ObservedFactPatch {
  const content = /<span\b[^>]*id=["']startOfPageId\d+["'][^>]*>[\s\S]*?(?=<!--END CONTENT-->)/i.exec(body)?.[0];
  if (!content || !/descripcionWrapper/.test(content)) {
    throw new Error('teatro-zarzuela: ficha K2 no reconocible');
  }
  const titleEnd = /<h3\b[^>]*class=["']titulo["'][^>]*>[\s\S]*?<\/h3>/i.exec(content);
  const sections = [...content.matchAll(/<div\b[^>]*class=["']encabezado-bloque["'][^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/div>/gi)];
  if (!titleEnd || !sections.length) throw new Error('teatro-zarzuela: ficha sin título o secciones');
  const introHtml = content.slice(titleEnd.index + titleEnd[0].length, sections[0]!.index)
    .split('<!-- BOTONES COMPRA')[0]!;
  const section = (name: RegExp): string => {
    const index = sections.findIndex((s) => name.test(stripTags(s[1]!)));
    if (index < 0) return '';
    const heading = sections[index]!;
    return content.slice(heading.index! + heading[0].length, sections[index + 1]?.index)
      .split('<!-- Plugins: AfterDisplayContent')[0]!;
  };
  const scheduleHtml = section(/^Fechas y Horarios$/i);
  const artistic = section(/^Ficha Art[ií]stica$/i);
  const program = section(/^Programa$/i);
  const categoryText = stripTags(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(content)?.[1] ?? '');
  const introText = flattenHtmlBlocks(introHtml);
  const artisticText = flattenHtmlBlocks(artistic);
  const description = [introText, artisticText].filter(Boolean).join('\n');
  const scheduleText = stripTags(scheduleHtml);
  // A single RawEvent cannot assign different venues to its performances.
  // Never assign an external co-production to this theatre by default.
  if (hasExternalZarzuelaVenue(scheduleText)) {
    throw new Error('teatro-zarzuela: sede externa o múltiple; requiere calendario por sede');
  }
  const occurrences = parseZarzuelaSchedule(scheduleHtml);
  const performers: ObservedPerson[] = [];
  for (const pair of artistic.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = stripTags(pair[1]!);
    const value = stripTags(pair[2]!);
    if (!label || !value) continue;
    if (ROLE.test(label) && !/<dl\b/i.test(pair[2]!)) performers.push({ name: value, roleText: label });
    else if (ROLE.test(value)) performers.push({ name: label, roleText: value });
    // Alternating casts remain in description, never flattened into an
    // assertion that every singer participates in every performance.
  }
  const composers = extractZarzuelaMusicCredits(introHtml).map((name) => ({ name }));
  const programText = flattenHtmlBlocks(program) || undefined;
  const status = inferScheduleFromText(`${description} ${scheduleText}`).eventStatus;
  return {
    description: description || undefined,
    categoryText: categoryText || undefined,
    programText,
    venueText: 'Teatro de la Zarzuela',
    occurrences,
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(composers),
    ...(status ? { eventStatus: status } : {}),
    ...(/>\s*Comprar entradas\s*</i.test(content) ? { accessText: 'Comprar entradas' } : {}),
  };
}

const MUSIC_CREDIT = /^(?:m[úu]sica)(?:\s+de)?\s*[:.]?\s*(.*)$/i;
const NEXT_CREDIT_LABEL =
  /^(?:libreto|texto(?:\s+del\s+pr[oó]logo)?|versi[oó]n|adaptaci[oó]n|orquestaci[oó]n|coproducci[oó]n|producci[oó]n|direcci[oó]n|coreograf[ií]a)\b/i;
const INLINE_NEXT_CREDIT =
  /\s+(?=libreto\b|texto(?:\s+del\s+pr[oó]logo)?\b|versi[oó]n\b|adaptaci[oó]n\b|orquestaci[oó]n\b|coproducci[oó]n\b|producci[oó]n\b)/i;
const MUSIC_GENRE_VALUE =
  /^(?:c[áa]mara|cl[áa]sica|vocal|instrumental|antigua|contempor[áa]nea|barroca|sinf[oó]nica|l[íi]rica)\b/i;

/**
 * Author credit from the introduction: "Música de NOMBRE", "Música: NOMBRE"
 * or "Música NOMBRE". Block/break boundaries are preserved first; inline
 * tags are stripped afterwards. Does not scan the cast for surnames.
 */
function extractZarzuelaMusicCredits(introHtml: string): string[] {
  const lines = flattenHtmlBlocks(introHtml).split('\n');
  const names: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = MUSIC_CREDIT.exec(lines[index]!);
    if (!match) continue;
    let value = match[1]?.trim() ?? '';
    if (!value) {
      const next = lines[index + 1]?.trim() ?? '';
      if (next && !NEXT_CREDIT_LABEL.test(next) && !MUSIC_CREDIT.test(next)) value = next;
    }
    value = value.split(INLINE_NEXT_CREDIT)[0]!.trim();
    if (!value || MUSIC_GENRE_VALUE.test(value) || NEXT_CREDIT_LABEL.test(value)) continue;
    names.push(value);
  }
  return names;
}

/**
 * "En la sala principal del Teatro de la Zarzuela" is this theatre's hall, not
 * an external SALA. Fundación / other theatres / auditorios stay external.
 */
function hasExternalZarzuelaVenue(scheduleText: string): boolean {
  const pattern = /\bEN (?:LA|EL) (?:FUNDACI[ÓO]N|TEATRO (?!DE LA ZARZUELA)|AUDITORIO|ESPACIO|SALA)\b/gi;
  for (const match of scheduleText.matchAll(pattern)) {
    const around = scheduleText.slice(match.index, match.index + 80);
    if (/sala principal(?: del teatro de la zarzuela)?/i.test(around)) continue;
    return true;
  }
  return false;
}
