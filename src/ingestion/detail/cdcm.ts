import { parseObservedDateTime } from '../dates.ts';
import { decodeHtmlEntities, flattenHtmlBlocks, stripTags } from '../html.ts';
import { emptyObservedLists, normalizePersonList, type ObservedFactPatch, type ObservedPerson } from '../observed.ts';
import { IncompleteListingError, type AdapterContext, type RawEvent, type RawOccurrence } from '../types.ts';
import { parseCanalProgrammeConcerts, parseScheduleDates } from './teatros-canal.ts';
import { sourceConflict } from './conflicts.ts';

export const CDCM_ROOT = 'https://www.cdcm.madrid';
export const CDCM_CANAL_LIST = `${CDCM_ROOT}/teatroscanal/programacion/categoria/musica`;
export const CDCM_ESCORIAL_LIST = `${CDCM_ROOT}/auditorioescorial/programacion`;
const METADATA_ORIGIN = 'https://origin202603-cdcm.cdcm.madrid';
type Site = 'teatroscanal' | 'auditorioescorial';
function siteFor(sourceId: string): Site {
  if (sourceId === 'teatros-canal') return 'teatroscanal';
  if (sourceId === 'teatro-auditorio-escorial') return 'auditorioescorial';
  throw new Error('CDCM: fuente no permitida');
}
export function isCdcmUrl(url: string): boolean { return new URL(url).origin === CDCM_ROOT; }
function publicUrl(value: unknown, site: Site, metadata = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(decodeHtmlEntities(value), CDCM_ROOT);
    if (u.username || u.password || u.port || u.search || u.hash ||
        (u.origin !== CDCM_ROOT && !(metadata && u.origin === METADATA_ORIGIN)) ||
        !new RegExp(`^/${site}/espectaculo/[a-z0-9-]+/?$`).test(u.pathname)) return undefined;
    return `${CDCM_ROOT}${u.pathname.replace(/\/$/, '')}`;
  } catch { return undefined; }
}
function jsonScripts(body: string, type: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const m of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let doc: unknown;
    try { doc = JSON.parse(m[1]!); } catch { throw Error('CDCM: JSON-LD inválido'); }
    const nodes = Array.isArray(doc) ? doc : [doc];
    for (const n of nodes) if (n && typeof n === 'object' && n['@type'] === type) out.push(n);
  }
  return out;
}
/** Balanced, source-local field extraction: nested room/media articles cannot end a ficha. */
function elements(body: string, className: string): string[] {
  const result: string[] = [];
  const open = /<(div|article|section|p|span)\b[^>]*class=["']([^"']*)["'][^>]*>/gi;
  for (const m of body.matchAll(open)) {
    if (!m[2]!.split(/\s+/).includes(className)) continue;
    const tags = new RegExp(`<\\/?${m[1]}\\b[^>]*>`, 'gi');
    tags.lastIndex = m.index! + m[0].length;
    const start = tags.lastIndex;
    let depth = 1, t: RegExpExecArray | null;
    while ((t = tags.exec(body))) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { result.push(body.slice(start, t.index)); break; }
    }
    if (depth !== 0) throw Error(`CDCM: bloque ${className} truncado`);
  }
  return result;
}
function field(body: string, name: string): string {
  const found = elements(body, `field--name-field-${name}`);
  if (found.length > 1) throw Error(`CDCM: campo ${name} ambiguo`);
  return found[0] ?? '';
}
function canonical(body: string): URL {
  const links = [...body.matchAll(/<link\b(?=[^>]*rel=["']canonical["'])[^>]*href=["']([^"']+)["'][^>]*>/gi)];
  if (links.length !== 1) throw Error('CDCM: falta canonical único');
  const u = new URL(decodeHtmlEntities(links[0]![1]!));
  if (![CDCM_ROOT, METADATA_ORIGIN].includes(u.origin) || u.username || u.password || u.port || u.search || u.hash) throw Error('CDCM: canonical ajeno');
  return u;
}
function yearsRange(text: string): { from: string; to: string } {
  const years = [...text.matchAll(/\b20\d{2}\b/g)].map(m => m[0]);
  if (!years.length || new Set(years).size > 2) throw Error('CDCM: fecha visible sin año verificable');
  return { from: `${years[0]}-01-01`, to: `${years.at(-1)}-12-31` };
}
function visibleDates(text: string, range: { from: string; to: string }): RawOccurrence[] {
  const parsed = parseScheduleDates(text, range);
  if (!parsed.length) throw Error('CDCM: calendario visible sin fechas explícitas verificables');
  return parsed;
}

function parseListingPage(body: string, url: string, site: Site) {
  const requested = new URL(url);
  if (requested.origin !== CDCM_ROOT || canonical(body).pathname !== requested.pathname) throw Error('CDCM: identidad de listado distinta');
  const script = /<script\b[^>]*data-drupal-selector="drupal-settings-json"[^>]*>([\s\S]*?)<\/script>/i.exec(body)?.[1];
  let settings: any;
  try { settings = JSON.parse(script ?? ''); } catch { throw Error('CDCM: falta configuración Views'); }
  const views = Object.values(settings?.views?.ajaxViews ?? {}) as any[];
  const expectedView = site === 'teatroscanal' ? 'tdc_show_search' : 'te_show_search';
  if (views.filter(v => v.view_name === expectedView && v.view_display_id === 'page_show_schedule_search' &&
      v.view_path === requested.pathname).length !== 1) throw Error('CDCM: vista de programación no verificada');
  const docs = jsonScripts(body, 'CollectionPage');
  if (docs.length !== 1 || docs[0]!.mainEntity?.['@type'] !== 'ItemList' || !Array.isArray(docs[0]!.mainEntity.itemListElement)) throw Error('CDCM: listado sin ItemList');
  const schema = docs[0]!.mainEntity.itemListElement as any[];
  const cards = elements(body, 'event-card');
  if (cards.length !== schema.length || (!cards.length && !/class="view-empty"/.test(body))) throw Error('CDCM: tarjetas y listado estructurado incompletos');
  const seen = new Set<string>();
  const events = cards.map((card, i): RawEvent => {
    const links = [...card.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*class="event-card__title-link"[^>]*>([\s\S]*?)<\/a>/g)];
    const sourceUrl = links.length === 1 && publicUrl(links[0]![1], site);
    const title = links.length === 1 && stripTags(links[0]![2]!);
    const dateText = stripTags(elements(card, 'event-card__date')[0] ?? '');
    const item = schema[i];
    if (!sourceUrl || !title || !dateText || seen.has(sourceUrl) || item?.position !== i + 1 ||
        item.item?.['@type'] !== 'Event' || publicUrl(item.item.url, site, true) !== sourceUrl || stripTags(item.item.name ?? '') !== title) throw Error('CDCM: tarjeta sin identidad, título o fecha coherentes');
    seen.add(sourceUrl);
    const dates = visibleDates(dateText, yearsRange(dateText));
    const category = stripTags(elements(card, 'event-card__category')[0] ?? '');
    if (!category || (site === 'teatroscanal' && category !== 'MÚSICA')) throw Error('CDCM: categoría del listado inesperada');
    return { sourceId: site === 'teatroscanal' ? 'teatros-canal' : 'teatro-auditorio-escorial', sourceUrl,
      listingDateText: dateText, observed: { title, categoryText: category,
        occurrences: dates.map(({ date, raw }) => ({ date, raw })), ...emptyObservedLists() } };
  });
  const pagerClass = site === 'teatroscanal' ? 'view-tdc-show-schedule__pager' : 'view-te-show-schedule__pager';
  const pagers = elements(body, pagerClass);
  if (pagers.length !== 1) throw Error('CDCM: falta el contenedor de paginación');
  const pager = pagers[0]!;
  const page = Number(requested.searchParams.get('page') ?? 0);
  const next: string[] = [];
  for (const link of pager.matchAll(/href="([^"]+)"/g)) {
    const u = new URL(decodeHtmlEntities(link[1]!), requested);
    if (u.origin !== CDCM_ROOT || u.pathname !== requested.pathname || u.username || u.password || u.hash ||
        [...u.searchParams.keys()].some(k => k !== 'page') || !/^\d+$/.test(u.searchParams.get('page') ?? '')) throw Error('CDCM: paginación fuera del listado');
    const n = Number(u.searchParams.get('page'));
    if (n > 19) throw Error('CDCM: límite de paginación');
    if (n > page) next.push(u.href);
  }
  if (page > 0) {
    const current = /class="[^"]*is-active[^"]*"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(pager)?.[1];
    if (!current || !new RegExp(`\\b${page + 1}\\b`).test(stripTags(current))) throw Error('CDCM: página repetida o actual no verificable');
  }
  return { events, next };
}

export async function extractCdcm(body: string, url: string, ctx: AdapterContext): Promise<RawEvent[]> {
  const site = siteFor(ctx.source.id);
  const events: RawEvent[] = [], seen = new Set<string>(), pages = new Set<string>();
  const pending: Array<{ url: string; body?: string }> = [{ url, body }];
  while (pending.length) {
    const entry = pending.shift()!;
    if (pages.has(entry.url)) continue;
    try {
      if (pages.size >= 20) throw Error('CDCM: límite de páginas');
      const parsed = parseListingPage(entry.body ?? await ctx.get(entry.url), entry.url, site);
      for (const event of parsed.events) {
        if (seen.has(event.sourceUrl)) throw Error('CDCM: ficha repetida entre páginas');
        seen.add(event.sourceUrl);
      }
      events.push(...parsed.events); pages.add(entry.url);
      pending.push(...parsed.next.map(url => ({ url })));
    } catch (error) {
      if (events.length) throw new IncompleteListingError(`CDCM: listado incompleto (${error instanceof Error ? error.message : String(error)})`, events);
      throw error;
    }
  }
  // Empty rendered pager proves no navigable continuation, not a publication horizon.
  // No disappearance is ever inferred from this migrated, undated-horizon listing.
  ctx.reportTemporalCoverage?.({ status: 'unknown', evidence: 'CDCM Views + ItemList + tarjetas y pager verificados; sin horizonte temporal publicado' });
  return events.map(event => ({ ...event, cdcmListingUrls: [...seen] }));
}

function detailFacts(event: RawEvent, body: string) {
  const site = siteFor(event.sourceId);
  const articles = elements(body, 'node--view-mode-full');
  if (articles.length !== 1) throw Error('CDCM: falta ficha de evento única');
  const own = articles[0]!.split(/<div\b[^>]*class="content-other--events\b/)[0]!;
  const title = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(own)?.[1] ?? '');
  const schemas = jsonScripts(body, 'Event');
  if (schemas.length !== 1 || publicUrl(canonical(body).href, site, true) !== event.sourceUrl ||
      publicUrl(schemas[0]!.url, site, true) !== event.sourceUrl || title !== event.observed.title || stripTags(schemas[0]!.name ?? '') !== title) {
    throw sourceConflict('CDCM: identidad de ficha contradictoria', 'identity', [{ surface: 'listing', value: event.sourceUrl }, { surface: 'detail', value: schemas[0]?.url ?? '' }]);
  }
  const schema = schemas[0]!;
  const place = schema.location;
  const location = site === 'teatroscanal' ? 'Teatros del Canal' : 'Auditorio Escorial';
  const street = site === 'teatroscanal' ? /Cea Bermúdez/i : /Parque Felipe II/i;
  if (place?.['@type'] !== 'Place' || place.name !== location || !street.test(place.address?.streetAddress ?? '') || place.address?.addressCountry !== 'ES') throw Error('CDCM: sede o dirección no verificadas');
  const schedules = schema.eventSchedule === undefined ? [schema] : schema.eventSchedule;
  if (!Array.isArray(schedules) || !schedules.length) throw Error('CDCM: calendario estructurado incompleto');
  const parsed = schedules.map((s: any) => {
    if (typeof s?.startDate !== 'string' || typeof s?.endDate !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(s.startDate) || !/(?:Z|[+-]\d\d:\d\d)$/.test(s.endDate)) throw Error('CDCM: calendario sin offset');
    const start = parseObservedDateTime(s.startDate), end = parseObservedDateTime(s.endDate);
    if (!start || !end || new Date(s.endDate).getTime() < new Date(s.startDate).getTime()) throw Error('CDCM: calendario estructurado inválido');
    return { start, end, envelope: start.time === '00:00' && end.time === '23:59', raw: s.startDate };
  });
  const from = parsed.map(s => s.start.date).sort()[0]!, to = parsed.map(s => s.end.date).sort().at(-1)!;
  const display = stripTags(field(own, 'display-date'));
  const visible = visibleDates(display, { from, to });
  if (visible.some(o => !parsed.some(s => o.date! >= s.start.date && o.date! <= s.end.date)) ||
      parsed.some(s => !visible.some(o => o.date === s.start.date) || !visible.some(o => o.date === s.end.date))) throw Error('CDCM: fechas visibles y schema contradictorios');
  const listed = event.observed.occurrences.map(o => o.date).sort();
  if (JSON.stringify(listed) !== JSON.stringify(visible.map(o => o.date).sort())) throw sourceConflict('CDCM: fecha de ficha distinta del listado', 'date', [{ surface:'listing',value:JSON.stringify(listed) }, { surface:'detail',value:display }]);
  return { own, site, parsed, from, to, visible };
}
function cycleConcerts(event: RawEvent, own: string, range: { from: string; to: string }) {
  const info = field(own, 'info');
  const all = parseCanalProgrammeConcerts(`<div class="tab-content" id="tabs1-info">${info}</div>`, range);
  const linked = new Set<string>();
  for (const paragraph of info.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const url = /href="([^"]+)"/.exec(paragraph[1]!)?.[1];
    if (url && event.cdcmListingUrls?.includes(publicUrl(url, 'teatroscanal') ?? '')) {
      const concert = parseCanalProgrammeConcerts(`<div class="tab-content" id="tabs1-info"><p>${paragraph[1]}</p></div>`, range);
      for (const c of concert) linked.add(c.date);
    }
  }
  return { all, remaining: all.filter(c => !linked.has(c.date)) };
}
function roomName(text: string): string | undefined {
  const names = [...text.matchAll(/\bSala (?:Roja(?: Concha Velasco)?|Verde|Negra|de Cristal)\b/gi)].map(m => /Roja/i.test(m[0]) ? 'Sala Roja Concha Velasco' : m[0]);
  const unique = [...new Set(names.map(n => n.replace(/^sala /i,'Sala ')))];
  return unique.length === 1 ? unique[0] : undefined;
}
export function parseCdcmDetail(event: RawEvent, body: string): ObservedFactPatch {
  const facts = detailFacts(event, body);
  const { own, site, parsed, from, to, visible } = facts;
  const schedule = flattenHtmlBlocks(field(own,'dates-times'));
  const info = field(own,'info');
  const cycle = cycleConcerts(event, own, { from, to });
  if (cycle.all.length > 1) {
    if (JSON.stringify(cycle.all.map(c=>c.date).sort()) !== JSON.stringify(visible.map(o=>o.date).sort()) || cycle.all.some(c=>!c.time) || !cycle.remaining.length) throw Error('CDCM: ciclo sin sesiones independientes verificadas');
    const one = cycle.remaining.length === 1 ? cycle.remaining[0] : undefined;
    return { ...(one ? { title: `${event.observed.title}: ${one.name}`, venueText: one.venueText, performers:[{name:one.name}] } : {}),
      occurrences: cycle.remaining.map(c=>({raw:c.raw,date:c.date,time:c.time})), description: flattenHtmlBlocks(info), categoryText:'Música contemporánea', accessText: /Entrada libre/i.test(own) ? 'Entrada libre hasta completar aforo' : undefined };
  }
  const scheduled = schedule ? parseScheduleDates(schedule, { from, to }) : [];
  if (scheduled.length && JSON.stringify(scheduled.map(o=>o.date).sort()) !== JSON.stringify(visible.map(o=>o.date).sort())) throw Error('CDCM: calendario visible de horarios contradictorio');
  const occurrences = visible.map(o => {
    const schema = parsed.find(s => o.date! >= s.start.date && o.date! <= s.end.date)!;
    const blocks = schedule.split('\n');
    const dateIndex = blocks.findIndex(line => parseScheduleDates(line,{from,to}).some(d=>d.date===o.date));
    const local = dateIndex >= 0 ? blocks.slice(dateIndex, blocks.findIndex((line,i)=>i>dateIndex && parseScheduleDates(line,{from,to}).length)>dateIndex ? blocks.findIndex((line,i)=>i>dateIndex && parseScheduleDates(line,{from,to}).length) : blocks.length).join(' ') : '';
    const clocks = [...local.matchAll(/\b(\d{1,2})[.:]([0-5]\d)\s*h\b/gi)].map(m => `${m[1]!.padStart(2,'0')}:${m[2]}`);
    if (new Set(clocks).size > 1 || clocks.some(t=>Number(t.slice(0,2))>23)) throw Error('CDCM: hora visible ambigua o inválida');
    const explicit = clocks[0];
    const structured = !schema.envelope && schema.start.date === schema.end.date ? schema.start.time : undefined;
    if (explicit && structured && explicit !== structured) throw sourceConflict('CDCM: horas visible y estructurada contradictorias', 'time',[{surface:'visible',value:explicit},{surface:'schema',value:structured}]);
    const time = explicit ?? structured;
    return {raw: `${o.raw}${time ? ` ${time}`:''}`,date:o.date,...(time ? {time}: {})};
  });
  const room = roomName(schedule || stripTags(/<h2\b[^>]*>[\s\S]*?Sala[\s\S]*?<\/h2>/i.exec(own)?.[0] ?? ''));
  if (site === 'teatroscanal' && !room) throw Error('CDCM: sala de Canal no verificable');
  const artistic = field(own,'artistic-sheet');
  const program = programme(artistic);
  const creditHtml = artistic.split(/<p[^>]*>\s*(?:<strong>)?\s*Programa\b/i)[0] ?? '';
  const performers: ObservedPerson[] = flattenHtmlBlocks(creditHtml).split('\n').flatMap(line => {
    const m = /^([^,:]{2,100}),\s*(piano|soprano|tenor|órgano|guitarras?|clarinete|percusión|directora?(?:\s+.*)?)$/iu.exec(line);
    if (m) return m[1]!.split(/\s+&\s+/).map(name => ({name:name.trim(),roleText:m[2]!.trim()}));
    const director = /^Director(?:a)?(?: del coro| JORCAM)?:\s*(.+)$/iu.exec(line);
    if (director) return [{name:director[1]!.trim(),roleText:'director'}];
    if (/^(?:Orquesta y Coro|Coro|Joven Orquesta|Joven Camerata|Pequeños Cantores)\b/i.test(line) && line.length<160) return [{name:line.replace(/:$/,'').trim()}];
    return [];
  });
  return { occurrences, venueText: site === 'teatroscanal' ? room! : 'Teatro Auditorio de San Lorenzo de El Escorial',
    description: [stripTags(elements(own,'field-pretitle')[0] ?? ''), stripTags(field(own,'press-quote')),flattenHtmlBlocks(info)].filter(Boolean).join('\n'),
    categoryText: [stripTags(field(own,'main-event-category')),flattenHtmlBlocks(field(own,'event-tags'))].filter(Boolean).join('; '),
    ...(program ? { programText:program.text, works:program.works, composers:program.composers } : {}),
    ...(performers.length ? {performers: normalizePersonList(performers)}:{}),
    ...(/Entrada libre/i.test(own) ? {accessText:'Entrada libre hasta completar aforo'} : field(own,'price') ? {accessText:stripTags(field(own,'price'))}:{}),
  };
}
/** Programme only: explicit author/italic work paragraphs, never synopsis or production credits. */
function programme(html: string) {
  const start = /\bPrograma\s*:?\s*(?:<\/strong>)?/i.exec(html);
  if (!start) return undefined;
  const section = html.slice(start.index + start[0].length);
  const works: Array<{title:string;composerName:string}> = [];
  for (const p of section.matchAll(/(?:^|<p\b[^>]*>)([\s\S]*?)<\/p>/gi)) {
    const paragraph = p[1]!.replace(/^(?:\s|<br\s*\/?>)+/gi, '');
    const parts = paragraph.split(/<br\s*\/?>/i);
    if (parts.length < 2) continue;
    const composerName = stripTags(parts[0]!).replace(/\s*\(\d{4}[^)]*\)/g, '').replace(/:$/,'').trim();
    const work = parts.slice(1).join('<br>');
    const m = /^\s*<em>([\s\S]*?)<\/em>([^<]*)/i.exec(work);
    // Mixed/compound credits remain explicit programme text, never composer names.
    if (!m || !/^[\p{L}.'’ -]+$/u.test(composerName) || !composerName.includes(' ') || /^(?:Programa|Música|Tradicional)\b/i.test(composerName)) continue;
    const title = stripTags(`${m[1]}${m[2]}`).replace(/[,;]$/,'').trim();
    if (title) works.push({title,composerName});
  }
  return {text:flattenHtmlBlocks(section),works,composers:[...new Set(works.map(w=>w.composerName))].map(name=>({name}))};
}
export function expandCdcm(event: RawEvent, body: string): RawEvent[] | undefined {
  // hydrate already validated identity, venue and the full schema/visible date set.
  const own = elements(body, 'node--view-mode-full')[0]!.split(/<div\b[^>]*class="content-other--events\b/)[0]!;
  const range = yearsRange(stripTags(field(own, 'display-date')));
  const cycle = cycleConcerts(event, own, range);
  if (cycle.remaining.length < 2) return undefined;
  return cycle.remaining.map(c => ({...event, observed:{...event.observed,title:`${event.observed.title}: ${c.name}`,venueText:c.venueText,occurrences:[{raw:c.raw,date:c.date,time:c.time}],performers:[{name:c.name}]}}));
}
