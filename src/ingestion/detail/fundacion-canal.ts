import { isRealIsoDate } from '../../lib/util/iso-date.ts';
import { parseObservedTime } from '../dates.ts';
import { decodeHtmlEntities, stripTags } from '../html.ts';
import {
  emptyObservedLists,
  normalizeComposerList,
  normalizePersonList,
  normalizeWorkList,
  type ObservedComposer,
  type ObservedPerson,
  type ObservedWork,
} from '../observed.ts';
import type { RawEvent, RawOccurrence } from '../types.ts';

const HOST = 'www.fundacioncanal.com';
const CYCLES = {
  camara: {
    prefix: '/ciclo-musica-camara/',
    seriesFallback: 'Ciclo de Música de Cámara',
  },
  familia: {
    prefix: '/ciclo-musica-en-familia/',
    seriesFallback: 'Ciclo de música en familia',
  },
  otros: {
    prefix: '/otros-conciertos/',
    seriesFallback: 'Otros conciertos',
  },
} as const;

type CanalCycle = keyof typeof CYCLES;

const ARCHIVE_EMPTY =
  /no hay eventos|proximamente disponible|pr[oó]ximamente disponible/i;

export function detectCanalListing(body: string, url: string): CanalCycle {
  if (
    /pagina_ciclo_camara|post-type-archive-ciclo-musica-camara/i.test(body) ||
    /\/ciclo-musica-camara\/?$/i.test(url)
  ) {
    return 'camara';
  }
  if (
    /seccion_musica_familia|post-type-archive-musica-en-familia/i.test(body) ||
    /\/ciclo-musica-en-familia\//i.test(url)
  ) {
    return 'familia';
  }
  if (
    /post-type-archive-otros-conciertos/i.test(body) ||
    /\/otros-conciertos\//i.test(url)
  ) {
    return 'otros';
  }
  throw new Error('fundacion-canal: listado sin la estructura esperada de un ciclo musical');
}

export function extractCanalListing(body: string, url: string, sourceId: string): RawEvent[] {
  const cycle = detectCanalListing(body, url);
  return cycle === 'camara' ? extractCamara(body, url, sourceId) : extractArchive(body, url, sourceId, cycle);
}

function extractCamara(body: string, url: string, sourceId: string): RawEvent[] {
  const page = canalDiv(body, /<div\b[^>]*class=["'][^"']*\bpagina_ciclo_camara\b[^"']*["'][^>]*>/i);
  if (!page) throw new Error('fundacion-canal: falta la plantilla del ciclo de cámara');
  if (!/<h1\b[^>]*>[\s\S]*?m[uú]sica de c[aá]mara[\s\S]*?<\/h1>/i.test(page)) {
    throw new Error('fundacion-canal: falta la cabecera del ciclo de cámara');
  }
  if (!/<h2\b[^>]*>\s*PR[ÓO]XIMO CONCIERTO\s*<\/h2>/i.test(page)) {
    throw new Error('fundacion-canal: falta la sección de próximo concierto');
  }
  const itemUrls = itemListUrls(body).map((href) => canalConcertUrl(href, url, 'camara'));
  if (itemUrls.some((href) => !href)) {
    throw new Error('fundacion-canal: JSON-LD con URL de concierto no reconocible');
  }
  const cards = accordionCards(page);
  if (!cards.length && !itemUrls.length) return [];
  if (cards.length !== itemUrls.length) {
    throw new Error('fundacion-canal: el acordeón y el JSON-LD no describen los mismos conciertos');
  }
  const seriesText = headingText(page, 'h1') || CYCLES.camara.seriesFallback;
  const cycleIntro = stripTags(
    /<div\b[^>]*class=["'][^"']*\btexto_intro\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(page)?.[1] ?? '',
  ) || undefined;
  const sidebar = parseCamaraSidebar(page);
  const events = new Map<string, RawEvent>();
  for (let i = 0; i < cards.length; i += 1) {
    const sourceUrl = itemUrls[i]!;
    const card = parseCamaraCard(cards[i]!, sourceUrl, sourceId, seriesText, cycleIntro, sidebar);
    if (events.has(sourceUrl)) throw new Error('fundacion-canal: concierto duplicado en el listado de cámara');
    events.set(sourceUrl, card);
  }
  return [...events.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
}

function extractArchive(body: string, url: string, sourceId: string, cycle: 'familia' | 'otros'): RawEvent[] {
  const page =
    canalDiv(body, /<div\b[^>]*class=["'][^"']*\bpagina_categoria\b[^"']*["'][^>]*>/i) ??
    canalDiv(body, /<section\b[^>]*id=["']seccion_(?:musica_familia|encuentro)["'][^>]*>/i);
  if (!page) throw new Error('fundacion-canal: falta el archivo de próximos conciertos');
  if (/\brel=["']next["']|\/page\/\d+\/?/i.test(page)) {
    throw new Error('fundacion-canal: paginación no soportada');
  }
  const cardMarker = /<div\b[^>]*class=["'][^"']*\bexposiciones_contenido\b[^"']*["'][^>]*>/i;
  const cards: string[] = [];
  for (const match of page.matchAll(new RegExp(cardMarker.source, 'gi'))) {
    const card = canalDiv(page.slice(match.index), cardMarker);
    if (!card) throw new Error('fundacion-canal: tarjeta de archivo incompleta');
    cards.push(card);
  }
  if (!cards.length) {
    if (ARCHIVE_EMPTY.test(stripTags(page))) return [];
    throw new Error('fundacion-canal: archivo de próximos conciertos vacío sin aviso explícito');
  }
  const seriesText = headingText(page, 'h1') || CYCLES[cycle].seriesFallback;
  const events = new Map<string, RawEvent>();
  for (const card of cards) {
    const parsed = parseArchiveCard(card, url, sourceId, cycle, seriesText);
    if (events.has(parsed.sourceUrl)) throw new Error('fundacion-canal: concierto duplicado en el archivo');
    events.set(parsed.sourceUrl, parsed);
  }
  return [...events.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
}

function parseCamaraCard(
  card: string,
  sourceUrl: string,
  sourceId: string,
  seriesText: string,
  cycleIntro: string | undefined,
  sidebar: { venueText?: string; accessText?: string },
): RawEvent {
  const title = headingText(card, 'h3');
  const dateText = stripTags(/<div\b[^>]*class=["'][^"']*\bfecha\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '');
  const descriptionHtml =
    /<div\b[^>]*class=["'][^"']*\bdesplegable_descripcion\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '';
  const occurrence = parseCanalDateTime(dateText);
  if (!title || !occurrence) throw new Error('fundacion-canal: ficha de cámara sin título o fecha reconocible');
  const facts = factsFromCamaraProgram(descriptionHtml);
  const notes = notesText(descriptionHtml);
  return {
    sourceId,
    sourceUrl,
    externalId: new URL(sourceUrl).pathname.replace(/\/$/, ''),
    listingDateText: occurrence.raw,
    observed: {
      title,
      seriesText,
      description: notes || cycleIntro,
      programText: stripTags(descriptionHtml) || undefined,
      venueText: sidebar.venueText,
      accessText: sidebar.accessText,
      occurrences: [occurrence],
      performers: facts.performers,
      composers: facts.composers,
      works: facts.works,
    },
  };
}

function parseArchiveCard(
  card: string,
  base: string,
  sourceId: string,
  cycle: 'familia' | 'otros',
  seriesText: string,
): RawEvent {
  const titleLink = /<h2\b[^>]*class=["'][^"']*\bcategoria_titulo\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(
    card,
  );
  const sourceUrl = titleLink && canalConcertUrl(titleLink[1]!, base, cycle);
  const title = stripTags(titleLink?.[2] ?? '');
  const horario = stripTags(/<div\b[^>]*class=["'][^"']*\bhorario\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '');
  const occurrence = parseCanalDateTime(horario);
  const venueText =
    stripTags(/<div\b[^>]*class=["'][^"']*\bsala_fecha\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '') ||
    undefined;
  const description =
    stripTags(/<div\b[^>]*class=["'][^"']*\btexto_1\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? '') ||
    undefined;
  if (!sourceUrl || !title || !occurrence) {
    throw new Error('fundacion-canal: tarjeta de archivo sin título, URL oficial o fecha reconocible');
  }
  return {
    sourceId,
    sourceUrl,
    externalId: new URL(sourceUrl).pathname.replace(/\/$/, ''),
    listingDateText: occurrence.raw,
    observed: {
      title,
      seriesText,
      description,
      venueText,
      occurrences: [occurrence],
      ...emptyObservedLists(),
    },
  };
}

function parseCamaraSidebar(page: string): { venueText?: string; accessText?: string } {
  const sidebar = canalDiv(page, /<div\b[^>]*class=["'][^"']*\blista_comun\b[^"']*["'][^>]*>/i) ?? '';
  let venueText: string | undefined;
  let accessText: string | undefined;
  for (const match of sidebar.matchAll(/<div\b[^>]*class=["']elemento["'][^>]*>/gi)) {
    const block = canalDiv(sidebar.slice(match.index), /<div\b[^>]*class=["']elemento["'][^>]*>/i);
    if (!block) continue;
    const label = stripTags(
      /<div\b[^>]*class=["'][^"']*\btitulo_lista_comun\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '',
    );
    const value = stripTags(
      /<div\b[^>]*class=["'][^"']*\btexto_lista_comun\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '',
    );
    if (!label || !value) continue;
    if (/ubicaci[oó]n/i.test(label)) venueText = value;
    if (/donaci[oó]n|entrada/i.test(label)) accessText = `${label} ${value}`;
  }
  return { venueText, accessText };
}

function factsFromCamaraProgram(html: string): {
  performers: ObservedPerson[];
  composers: ObservedComposer[];
  works: ObservedWork[];
} {
  const sections = splitStrongSections(html);
  const performers: ObservedPerson[] = [];
  const workChunks: string[] = [];
  for (const section of sections) {
    const label = section.label.replace(/:$/, '');
    if (/^int[eé]rpretes$/i.test(label)) performers.push(...parsePerformerLines(section.html));
    else if (/^notas/i.test(label)) continue;
    else workChunks.push(section.html);
  }
  const works = normalizeWorkList(workChunks.flatMap(parseWorkLines));
  return {
    performers: normalizePersonList(performers),
    composers: normalizeComposerList(works.flatMap((work) => (work.composerName ? [{ name: work.composerName }] : []))),
    works,
  };
}

function splitStrongSections(html: string): Array<{ label: string; html: string }> {
  const parts = html.split(/<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i);
  if (parts.length === 1) return [{ label: '', html }];
  const sections: Array<{ label: string; html: string }> = [];
  sections.push({ label: '', html: parts[0] ?? '' });
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({ label: stripTags(parts[i] ?? ''), html: parts[i + 1] ?? '' });
  }
  return sections.filter((section) => stripTags(section.html) || section.label);
}

function parsePerformerLines(html: string): ObservedPerson[] {
  return splitProgramLines(html).flatMap((line) => {
    if (/^https?:\/\//i.test(line) || /youtube|youtu\.be/i.test(line)) return [];
    const people = line.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
    if (people.length > 1) {
      const last = people.at(-1)!;
      const credit = /^(.+),\s*([^,]+)$/.exec(last);
      const roleText = credit?.[2];
      const names = credit ? [...people.slice(0, -1), credit[1]!] : people;
      return names.map((name) => ({ name, ...(roleText ? { roleText } : {}) }));
    }
    const credit = /^(.+),\s*([^,]+)$/.exec(line);
    return [{ name: credit?.[1] ?? line, ...(credit ? { roleText: credit[2] } : {}) }];
  });
}

function parseWorkLines(html: string): ObservedWork[] {
  return splitProgramLines(html).flatMap((line) => {
    const dash = /^(.+?)\s+[–—]\s+(.+)$/.exec(line);
    if (dash) return [{ title: dash[2]!, composerName: stripComposerYears(dash[1]!) }];
    const colon = /^(.+?):\s+(.+)$/.exec(line);
    if (colon && !/^(programa|int[eé]rpretes)$/i.test(colon[1]!)) {
      return [{ title: colon[2]!, composerName: stripComposerYears(colon[1]!) }];
    }
    return [];
  });
}

function splitProgramLines(html: string): string[] {
  return html
    .split(/<\/p>|<br\s*\/?>/i)
    .map((part) => stripTags(part.replace(/<span\b[^>]*padding-left:[^>]*>[\s\S]*?<\/span>/gi, '')))
    .filter(Boolean);
}

function stripComposerYears(value: string): string {
  return value.replace(/\s*\(\s*(?:ca\.?\s*)?\d{3,4}\s*[–—-]\s*(?:ca\.?\s*)?\d{3,4}\s*\)\s*$/u, '').trim();
}

function notesText(html: string): string | undefined {
  const notes = /<p\b[^>]*>\s*<strong\b[^>]*>\s*Notas al concierto\s*<\/strong>\s*<\/p>([\s\S]*)$/i.exec(html)?.[1];
  return notes ? stripTags(notes) || undefined : undefined;
}

function accordionCards(page: string): string[] {
  const cards: string[] = [];
  for (const match of page.matchAll(/<div\b[^>]*class=["'][^"']*\belemento_extra\b[^"']*["'][^>]*>/gi)) {
    const card = canalDiv(page.slice(match.index), /<div\b[^>]*class=["'][^"']*\belemento_extra\b[^"']*["'][^>]*>/i);
    if (!card) throw new Error('fundacion-canal: acordeón incompleto');
    cards.push(card);
  }
  return cards;
}

function itemListUrls(html: string): string[] {
  const urls: string[] = [];
  let foundList = false;
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]!);
    } catch {
      throw new Error('fundacion-canal: JSON-LD inválido');
    }
    if (collectItemListUrls(data, urls)) foundList = true;
  }
  if (!foundList) throw new Error('fundacion-canal: falta el JSON-LD ItemList del listado de cámara');
  return urls;
}

function collectItemListUrls(value: unknown, urls: string[]): boolean {
  if (Array.isArray(value)) {
    return value.reduce((found, item) => collectItemListUrls(item, urls) || found, false);
  }
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  let found = false;
  if ('@graph' in record) found = collectItemListUrls(record['@graph'], urls) || found;
  const entity = record.mainEntity;
  const list = entity && typeof entity === 'object' ? (entity as Record<string, unknown>) : record;
  const type = String(list['@type'] ?? '');
  if (type === 'ItemList' && Array.isArray(list.itemListElement)) {
    found = true;
    for (const item of list.itemListElement) {
      if (!item || typeof item !== 'object') continue;
      const href = (item as { url?: unknown }).url;
      if (typeof href === 'string' && href) urls.push(decodeHtmlEntities(href));
    }
  }
  return found;
}

export function canalConcertUrl(href: string, base: string, cycle: CanalCycle): string | undefined {
  try {
    const parsed = new URL(decodeHtmlEntities(href), base);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:') return undefined;
    if (parsed.hostname.toLowerCase() !== HOST) return undefined;
    const prefix = CYCLES[cycle].prefix;
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const rest = parsed.pathname.slice(prefix.length).replace(/\/$/, '');
    if (!rest || rest === 'proximas' || rest === 'pasadas' || rest === 'feed' || rest.startsWith('page/')) {
      return undefined;
    }
    if (rest.includes('/')) return undefined;
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = `${prefix}${rest}`;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function parseCanalDateTime(raw: string): RawOccurrence | undefined {
  const text = stripTags(raw).replace(/^(?:fecha y hora|fecha)\s*:\s*/i, '');
  const match = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}:\d{2})\s*h\.?)?/i.exec(text);
  if (!match) return undefined;
  const date = `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  if (!isRealIsoDate(date)) return undefined;
  const time = match[4] ? parseObservedTime(match[4]) : undefined;
  if (match[4] && !time) return undefined;
  return { raw: text, date, ...(time ? { time } : {}) };
}

function headingText(html: string, tag: 'h1' | 'h2' | 'h3'): string {
  return stripTags(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html)?.[1] ?? '');
}

/** Balanced reader scoped to an explicitly identified CMS div. */
export function canalDiv(html: string, marker: RegExp): string | undefined {
  const start = marker.exec(html);
  if (!start) return undefined;
  const offset = start.index + start[0].length;
  let depth = 1;
  for (const tag of html.slice(offset).matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(offset, offset + tag.index);
  }
  throw new Error('fundacion-canal: sección HTML incompleta');
}
