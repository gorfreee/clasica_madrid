import { stripTags } from '../html.ts';
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
  const description = stripTags(introHtml.replace(/<!--[\s\S]*?-->/g, ''));
  const scheduleText = stripTags(scheduleHtml);
  // A single RawEvent cannot assign different venues to its performances.
  // Never assign an external co-production to this theatre by default.
  if (/\bEN (?:LA|EL) (?:FUNDACI[ÓO]N|TEATRO (?!DE LA ZARZUELA)|AUDITORIO|ESPACIO|SALA\b)/i.test(scheduleText)) {
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
    // Alternating casts remain in programText, never flattened into an
    // assertion that every singer participates in every performance.
  }
  const composers = [...introHtml.matchAll(/M[úu]sica\s+(?:de\s+)?<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)]
    .map((m) => ({ name: stripTags(m[1]!) }));
  const programText = [stripTags(artistic), stripTags(program)].filter(Boolean).join(' ');
  const status = inferScheduleFromText(`${description} ${scheduleText}`).eventStatus;
  return {
    description: description || undefined,
    categoryText: categoryText || undefined,
    programText: programText || undefined,
    venueText: 'Teatro de la Zarzuela',
    occurrences,
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(composers),
    ...(status ? { eventStatus: status } : {}),
    ...(/>\s*Comprar entradas\s*</i.test(content) ? { accessText: 'Comprar entradas' } : {}),
  };
}
