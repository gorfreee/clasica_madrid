import ExcelJS from 'exceljs';
import { listSourceDefinitions } from '../../ingestion/registry.ts';
import type { SourceDefinition } from '../../ingestion/types.ts';
import { compareDateTime } from '../domain/dates.ts';
import { listCanonicalEvents } from '../domain/queries.ts';
import type { Catalog } from '../domain/catalog.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import type { Occurrence } from '../schemas/event.ts';
import { eventUrl } from '../presentation/urls.ts';
import {
  accessLabels,
  areaLabels,
  eraLabels,
  eventStatusLabel,
  formatLabels,
  kindLabels,
  performerRoleLabels,
  seriesKindLabels,
  sourceKindLabels,
} from '../presentation/labels.ts';

const LIST_SEP = '; ';

export type EventExportRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  kind: string;
  access: string;
  eras: string;
  formats: string;
  firstDate: string;
  lastDate: string;
  occurrenceCount: number;
  dates: string;
  performers: string;
  composers: string;
  works: string;
  venue: string;
  municipality: string;
  area: string;
  address: string;
  venueId: string;
  parentVenue: string;
  parentVenueId: string;
  spaceName: string;
  organizers: string;
  organizerIds: string;
  series: string;
  seriesKind: string;
  seriesId: string;
  primarySource: string;
  primarySourceUrl: string;
  citations: string;
  lastVerifiedAt: string;
  publicUrl: string;
};

type ColumnSpec<T extends object> = {
  header: string;
  key: keyof T & string;
  width: number;
};

const EVENT_COLUMNS: ColumnSpec<EventExportRow>[] = [
  { header: 'ID', key: 'id', width: 36 },
  { header: 'Slug', key: 'slug', width: 32 },
  { header: 'Título', key: 'title', width: 42 },
  { header: 'Estado', key: 'status', width: 12 },
  { header: 'Tipo', key: 'kind', width: 14 },
  { header: 'Acceso', key: 'access', width: 18 },
  { header: 'Épocas', key: 'eras', width: 28 },
  { header: 'Formatos', key: 'formats', width: 22 },
  { header: 'Primera fecha', key: 'firstDate', width: 14 },
  { header: 'Última fecha', key: 'lastDate', width: 14 },
  { header: 'Nº fechas', key: 'occurrenceCount', width: 12 },
  { header: 'Fechas', key: 'dates', width: 48 },
  { header: 'Intérpretes', key: 'performers', width: 40 },
  { header: 'Compositores', key: 'composers', width: 32 },
  { header: 'Obras', key: 'works', width: 48 },
  { header: 'Lugar', key: 'venue', width: 36 },
  { header: 'Municipio', key: 'municipality', width: 16 },
  { header: 'Área', key: 'area', width: 14 },
  { header: 'Dirección', key: 'address', width: 36 },
  { header: 'Lugar ID', key: 'venueId', width: 36 },
  { header: 'Lugar principal', key: 'parentVenue', width: 36 },
  { header: 'Lugar principal ID', key: 'parentVenueId', width: 36 },
  { header: 'Sala', key: 'spaceName', width: 28 },
  { header: 'Organizadores', key: 'organizers', width: 36 },
  { header: 'Organizadores ID', key: 'organizerIds', width: 28 },
  { header: 'Serie', key: 'series', width: 32 },
  { header: 'Tipo de serie', key: 'seriesKind', width: 14 },
  { header: 'Serie ID', key: 'seriesId', width: 32 },
  { header: 'Fuente principal', key: 'primarySource', width: 28 },
  { header: 'URL fuente principal', key: 'primarySourceUrl', width: 48 },
  { header: 'Citas', key: 'citations', width: 56 },
  { header: 'Verificado', key: 'lastVerifiedAt', width: 14 },
  { header: 'URL pública', key: 'publicUrl', width: 48 },
];

function join(values: readonly string[]): string {
  return values.filter(Boolean).join(LIST_SEP);
}

function formatOccurrence(occurrence: Occurrence): string {
  const time = occurrence.time ? ` ${occurrence.time}` : '';
  const cancelled = occurrence.status === 'cancelled' ? ' (cancelada)' : '';
  return `${occurrence.date}${time}${cancelled}`;
}

function sortedOccurrences(occurrences: readonly Occurrence[]): Occurrence[] {
  return [...occurrences].sort((left, right) =>
    compareDateTime(left.date, left.time, right.date, right.time),
  );
}

export function toEventExportRow(resolved: ResolvedEvent): EventExportRow {
  const { event, venue, rootVenue, spaceName, organizers, series, citations, primaryCitation } = resolved;
  const occurrences = sortedOccurrences(event.occurrences);
  const first = occurrences[0];
  const last = occurrences[occurrences.length - 1];
  if (!first || !last) {
    throw new Error(`Evento ${event.id} no tiene representaciones`);
  }

  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    status: eventStatusLabel(event.status),
    kind: kindLabels[event.kind],
    access: accessLabels[event.access],
    eras: join(event.eras.map((era) => eraLabels[era])),
    formats: join(event.formats.map((format) => formatLabels[format])),
    firstDate: first.date,
    lastDate: last.date,
    occurrenceCount: occurrences.length,
    dates: join(occurrences.map(formatOccurrence)),
    performers: join(
      event.performers.map((performer) =>
        performer.role ? `${performer.name} (${performerRoleLabels[performer.role]})` : performer.name,
      ),
    ),
    composers: join(event.composers.map((composer) => composer.name)),
    works: join(
      event.works.map((work) =>
        work.composerName ? `${work.title} — ${work.composerName}` : work.title,
      ),
    ),
    venue: venue.name,
    municipality: rootVenue.municipality,
    area: areaLabels[rootVenue.area],
    address: rootVenue.address ?? venue.address ?? '',
    venueId: venue.id,
    parentVenue: rootVenue.id === venue.id ? '' : rootVenue.name,
    parentVenueId: venue.parentVenueId ?? '',
    spaceName: spaceName ?? '',
    organizers: join(organizers.map((organizer) => organizer.name)),
    organizerIds: join(organizers.map((organizer) => organizer.id)),
    series: series?.name ?? '',
    seriesKind: series ? seriesKindLabels[series.kind] : '',
    seriesId: series?.id ?? '',
    primarySource: primaryCitation.source.name,
    primarySourceUrl: primaryCitation.url,
    citations: join(
      citations.map((citation) => {
        const primary = citation.isPrimary ? 'principal' : 'secundaria';
        return `${citation.url} [${citation.source.name}, ${primary}, ${citation.checkedAt}]`;
      }),
    ),
    lastVerifiedAt: event.lastVerifiedAt,
    publicUrl: eventUrl(event.slug),
  };
}

export function buildEventExportRows(catalog: Catalog): EventExportRow[] {
  return listCanonicalEvents(catalog)
    .map(toEventExportRow)
    .sort((left, right) => {
      const byDate = left.firstDate.localeCompare(right.firstDate);
      if (byDate !== 0) return byDate;
      return left.title.localeCompare(right.title, 'es');
    });
}

export type AdapterExportRow = {
  id: string;
  name: string;
  catalogSourceId: string;
  url: string;
  eventCount: number;
  primaryEventCount: number;
};

const ADAPTER_COLUMNS: ColumnSpec<AdapterExportRow>[] = [
  { header: 'ID', key: 'id', width: 28 },
  { header: 'Nombre', key: 'name', width: 40 },
  { header: 'Fuente ID', key: 'catalogSourceId', width: 40 },
  { header: 'URL', key: 'url', width: 48 },
  { header: 'Eventos (cita)', key: 'eventCount', width: 16 },
  { header: 'Eventos (principal)', key: 'primaryEventCount', width: 20 },
];

function bumpCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function catalogSourceEventCounts(catalog: Catalog): {
  cited: Map<string, number>;
  primary: Map<string, number>;
} {
  const cited = new Map<string, number>();
  const primary = new Map<string, number>();
  for (const event of catalog.events) {
    bumpCount(primary, event.primarySourceId);
    const seen = new Set<string>();
    for (const citation of event.citations) {
      if (seen.has(citation.sourceId)) continue;
      seen.add(citation.sourceId);
      bumpCount(cited, citation.sourceId);
    }
  }
  return { cited, primary };
}

function adapterIdsByCatalogSourceId(
  definitions: readonly SourceDefinition[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of definitions) {
    const existing = map.get(source.catalogSourceId);
    map.set(
      source.catalogSourceId,
      existing ? `${existing}${LIST_SEP}${source.id}` : source.id,
    );
  }
  return map;
}

export function buildAdapterExportRows(
  catalog: Catalog,
  definitions: readonly SourceDefinition[] = listSourceDefinitions(),
): AdapterExportRow[] {
  const counts = catalogSourceEventCounts(catalog);
  const sourceById = new Map(catalog.sources.map((source) => [source.id, source]));
  return [...definitions]
    .sort((left, right) => left.name.localeCompare(right.name, 'es'))
    .map((source) => {
      const canonical = sourceById.get(source.catalogSourceId) ?? source.seedSource;
      return {
        id: source.id,
        name: source.name,
        catalogSourceId: source.catalogSourceId,
        url: canonical.url,
        eventCount: counts.cited.get(source.catalogSourceId) ?? 0,
        primaryEventCount: counts.primary.get(source.catalogSourceId) ?? 0,
      };
    });
}

function applySheetStyle(sheet: ExcelJS.Worksheet, columnCount: number, rowCount: number): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rowCount, 1), column: columnCount },
  };
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 22;
}

function addSheet<T extends object>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ColumnSpec<T>[],
  rows: T[],
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }));
  for (const row of rows) {
    sheet.addRow(row);
  }
  applySheetStyle(sheet, columns.length, rows.length + 1);
}

function byName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name, 'es'));
}

export function buildCatalogWorkbook(catalog: Catalog): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Clásica Madrid';
  workbook.created = new Date();
  const registry = listSourceDefinitions();
  const adapterByCatalogSource = adapterIdsByCatalogSourceId(registry);

  addSheet(workbook, 'Eventos', EVENT_COLUMNS, buildEventExportRows(catalog));

  addSheet(
    workbook,
    'Lugares',
    [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Slug', key: 'slug', width: 32 },
      { header: 'Nombre', key: 'name', width: 40 },
      { header: 'Municipio', key: 'municipality', width: 16 },
      { header: 'Área', key: 'area', width: 14 },
      { header: 'Dirección', key: 'address', width: 36 },
      { header: 'URL', key: 'url', width: 48 },
      { header: 'Lugar principal ID', key: 'parentVenueId', width: 36 },
      { header: 'Sala', key: 'spaceName', width: 28 },
      { header: 'Verificado', key: 'lastVerifiedAt', width: 14 },
    ],
    byName(catalog.venues).map((venue) => ({
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      municipality: venue.municipality,
      area: areaLabels[venue.area],
      address: venue.address ?? '',
      url: venue.url ?? '',
      parentVenueId: venue.parentVenueId ?? '',
      spaceName: venue.spaceName ?? '',
      lastVerifiedAt: venue.lastVerifiedAt ?? '',
    })),
  );

  addSheet(
    workbook,
    'Organizadores',
    [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Slug', key: 'slug', width: 28 },
      { header: 'Nombre', key: 'name', width: 40 },
      { header: 'URL', key: 'url', width: 48 },
    ],
    byName(catalog.organizers).map((organizer) => ({
      id: organizer.id,
      slug: organizer.slug,
      name: organizer.name,
      url: organizer.url ?? '',
    })),
  );

  addSheet(
    workbook,
    'Series',
    [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Slug', key: 'slug', width: 32 },
      { header: 'Nombre', key: 'name', width: 40 },
      { header: 'Tipo', key: 'kind', width: 14 },
      { header: 'URL', key: 'url', width: 48 },
    ],
    byName(catalog.series).map((series) => ({
      id: series.id,
      slug: series.slug,
      name: series.name,
      kind: seriesKindLabels[series.kind],
      url: series.url ?? '',
    })),
  );

  addSheet(
    workbook,
    'Fuentes',
    [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Slug', key: 'slug', width: 32 },
      { header: 'Nombre', key: 'name', width: 36 },
      { header: 'Tipo', key: 'kind', width: 14 },
      { header: 'Adapter', key: 'adapter', width: 28 },
      { header: 'URL', key: 'url', width: 48 },
    ],
    byName(catalog.sources).map((source) => ({
      id: source.id,
      slug: source.slug,
      name: source.name,
      kind: sourceKindLabels[source.kind],
      adapter: adapterByCatalogSource.get(source.id) ?? '',
      url: source.url,
    })),
  );

  addSheet(workbook, 'Adaptadores', ADAPTER_COLUMNS, buildAdapterExportRows(catalog, registry));

  return workbook;
}

export async function writeCatalogWorkbook(catalog: Catalog, outputPath: string): Promise<void> {
  const workbook = buildCatalogWorkbook(catalog);
  await workbook.xlsx.writeFile(outputPath);
}
