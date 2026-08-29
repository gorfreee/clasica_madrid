import ExcelJS from 'exceljs';
import { compareDateTime } from '../domain/dates.ts';
import { listCanonicalEvents } from '../domain/queries.ts';
import type { Catalog } from '../domain/catalog.ts';
import type { ResolvedEvent } from '../domain/resolve.ts';
import type { Occurrence } from '../schemas/event.ts';
import { SITE_ORIGIN } from '../presentation/constants.ts';
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
  const { event, venue, organizers, series, citations, primaryCitation } = resolved;
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
    municipality: venue.municipality,
    area: areaLabels[venue.area],
    address: venue.address ?? '',
    venueId: venue.id,
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
    publicUrl: `${SITE_ORIGIN}/eventos/${event.slug}`,
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
      { header: 'URL', key: 'url', width: 48 },
    ],
    byName(catalog.sources).map((source) => ({
      id: source.id,
      slug: source.slug,
      name: source.name,
      kind: sourceKindLabels[source.kind],
      url: source.url,
    })),
  );

  return workbook;
}

export async function writeCatalogWorkbook(catalog: Catalog, outputPath: string): Promise<void> {
  const workbook = buildCatalogWorkbook(catalog);
  await workbook.xlsx.writeFile(outputPath);
}
