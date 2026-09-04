import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { listSourceDefinitions } from '../src/ingestion/registry.ts';
import type { SourceDefinition } from '../src/ingestion/types.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import {
  buildAdapterExportRows,
  buildCatalogWorkbook,
  buildEventExportRows,
} from '../src/lib/export/catalog-workbook.ts';
import { makeCatalog, makeEvent, makeSource, richCatalog } from './helpers.ts';

describe('exportación Excel del catálogo', () => {
  it('emite una fila por evento, no por representación', () => {
    const rows = buildEventExportRows(richCatalog());
    const carmen = rows.find((row) => row.id === 'evt_carmen');
    expect(carmen).toBeDefined();
    expect(carmen?.occurrenceCount).toBe(3);
    expect(carmen?.dates).toBe(
      '2026-09-10 19:00; 2026-09-12 19:00 (cancelada); 2026-09-14 18:00',
    );
    expect(carmen?.firstDate).toBe('2026-09-10');
    expect(carmen?.lastDate).toBe('2026-09-14');
  });

  it('resuelve nombres de lugar, organizadores y serie', () => {
    const [row] = buildEventExportRows(makeCatalog());
    expect(row?.venue).toBe('Auditorio Nacional de Música');
    expect(row?.organizers).toBe('Orquesta y Coro Nacionales de España');
    expect(row?.series).toBe('Ciclo de Cámara');
    expect(row?.primarySource).toBe('Auditorio Nacional');
    expect(row?.publicUrl).toBe('https://clasicamadrid.com/eventos/matinees-de-otono/');
  });

  it('ordena eventos por primera fecha y luego por título', () => {
    const rows = buildEventExportRows(richCatalog());
    expect(rows.map((row) => row.id)).toEqual([
      'evt_verano',
      'evt_carmen',
      'evt_organo_alcobendas',
      'evt_matinees_otono',
    ]);
  });

  it('formatea intérpretes, obras y un catálogo vacío', () => {
    const [row] = buildEventExportRows(
      makeCatalog({
        events: [
          makeEvent({
            performers: [{ name: 'OCNE', role: 'orchestra' }, { name: 'Invitado' }],
            works: [{ title: 'Sinfonía n.º 7', composerName: 'Ludwig van Beethoven' }],
          }),
        ],
      }),
    );
    expect(row?.performers).toBe('OCNE (Orquesta); Invitado');
    expect(row?.works).toBe('Sinfonía n.º 7 — Ludwig van Beethoven');
    expect(buildEventExportRows(emptyCatalog())).toEqual([]);
  });

  it('escribe un libro con una hoja por colección', async () => {
    const workbook = buildCatalogWorkbook(richCatalog());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Eventos',
      'Lugares',
      'Organizadores',
      'Series',
      'Fuentes',
      'Adaptadores',
    ]);

    const buffer = await workbook.xlsx.writeBuffer();
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer);

    const events = loaded.getWorksheet('Eventos');
    expect(events?.rowCount).toBe(5);
    expect(events?.getRow(1).getCell(1).value).toBe('ID');
    expect(events?.getRow(2).getCell(1).value).toBe('evt_verano');

    const venues = loaded.getWorksheet('Lugares');
    expect(venues?.rowCount).toBe(3);

    const adapters = loaded.getWorksheet('Adaptadores');
    const registry = listSourceDefinitions();
    expect(adapters?.rowCount).toBe(registry.length + 1);
    expect(headerValues(adapters)).toEqual([
      'ID',
      'Nombre',
      'Fuente ID',
      'URL',
      'Eventos (cita)',
      'Eventos (principal)',
    ]);
    const adapterIds = sheetColumn(adapters, 1).slice(1);
    expect(adapterIds).toEqual(
      [...registry].sort((left, right) => left.name.localeCompare(right.name, 'es')).map((source) => source.id),
    );
    expect(adapterIds).toContain('auditorio-nacional');
  });

  it('marca en Fuentes si la fuente canónica tiene adapter', async () => {
    const workbook = buildCatalogWorkbook(
      makeCatalog({
        sources: [
          makeSource({ id: 'src_auditorio_nacional', name: 'Auditorio Nacional de Música' }),
          makeSource({
            id: 'src_parroquia',
            slug: 'parroquia',
            name: 'Parroquia de San Manuel',
            url: 'https://example.org/san-manuel',
          }),
        ],
        events: [
          makeEvent({
            citations: [
              {
                sourceId: 'src_auditorio_nacional',
                url: 'https://auditorionacional.inaem.gob.es/evento',
                checkedAt: '2026-08-20',
              },
            ],
            primarySourceId: 'src_auditorio_nacional',
          }),
        ],
      }),
    );

    const sources = workbook.getWorksheet('Fuentes');
    expect(headerValues(sources)).toEqual(['ID', 'Slug', 'Nombre', 'Tipo', 'Adapter', 'URL']);
    expect(columnByHeader(sources, 'ID')).toEqual(['src_auditorio_nacional', 'src_parroquia']);
    expect(columnByHeader(sources, 'Adapter')).toEqual(['auditorio-nacional', '']);
  });

  it('cuenta eventos citados y principales por adapter', () => {
    const harvested = makeSource({
      id: 'src_harvest',
      slug: 'harvest',
      name: 'Fuente harvesteada',
      url: 'https://example.org/harvest',
    });
    const other = makeSource({
      id: 'src_other',
      slug: 'other',
      name: 'Otra fuente',
      url: 'https://example.org/other',
    });
    const catalog = makeCatalog({
      sources: [harvested, other],
      events: [
        makeEvent({
          id: 'evt_primary',
          slug: 'primary',
          title: 'Principal',
          citations: [
            { sourceId: harvested.id, url: 'https://example.org/a', checkedAt: '2026-08-20' },
          ],
          primarySourceId: harvested.id,
        }),
        makeEvent({
          id: 'evt_cited',
          slug: 'cited',
          title: 'Solo citado',
          citations: [
            { sourceId: other.id, url: 'https://example.org/b', checkedAt: '2026-08-20' },
            { sourceId: harvested.id, url: 'https://example.org/c', checkedAt: '2026-08-20' },
            { sourceId: harvested.id, url: 'https://example.org/c-dup', checkedAt: '2026-08-21' },
          ],
          primarySourceId: other.id,
        }),
      ],
    });

    const rows = buildAdapterExportRows(catalog, [
      fakeRegistrySource({
        id: 'harvest-adapter',
        name: 'Adapter Harvest',
        catalogSourceId: harvested.id,
        seedSource: harvested,
      }),
      fakeRegistrySource({
        id: 'empty-adapter',
        name: 'Adapter Vacío',
        catalogSourceId: 'src_empty',
        seedSource: makeSource({
          id: 'src_empty',
          slug: 'empty',
          name: 'Sin catálogo',
          url: 'https://example.org/empty',
        }),
      }),
    ]);

    expect(rows).toEqual([
      {
        id: 'harvest-adapter',
        name: 'Adapter Harvest',
        catalogSourceId: harvested.id,
        url: harvested.url,
        eventCount: 2,
        primaryEventCount: 1,
      },
      {
        id: 'empty-adapter',
        name: 'Adapter Vacío',
        catalogSourceId: 'src_empty',
        url: 'https://example.org/empty',
        eventCount: 0,
        primaryEventCount: 0,
      },
    ]);
  });
});

function fakeRegistrySource(overrides: Partial<SourceDefinition> & Pick<SourceDefinition, 'id' | 'name' | 'catalogSourceId' | 'seedSource'>): SourceDefinition {
  return {
    urls: ['https://example.org/listing'],
    adapterId: overrides.id,
    ...overrides,
  };
}

function headerValues(sheet: ExcelJS.Worksheet | undefined): unknown[] {
  const values = sheet?.getRow(1).values;
  return Array.isArray(values) ? values.slice(1) : [];
}

function sheetColumn(sheet: ExcelJS.Worksheet | undefined, column: number): unknown[] {
  if (!sheet) return [];
  const values: unknown[] = [];
  sheet.eachRow((row) => {
    values.push(row.getCell(column).value);
  });
  return values;
}

function columnByHeader(sheet: ExcelJS.Worksheet | undefined, header: string): unknown[] {
  const index = headerValues(sheet).indexOf(header);
  if (index < 0) return [];
  return sheetColumn(sheet, index + 1).slice(1);
}
