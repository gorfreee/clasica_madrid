import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogWorkbook,
  buildEventExportRows,
} from '../src/lib/export/catalog-workbook.ts';
import { emptyCatalog } from '../src/lib/domain/catalog.ts';
import { makeCatalog, makeEvent, richCatalog } from './helpers.ts';

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
    expect(row?.publicUrl).toBe('https://clasicamadrid.com/eventos/matinees-de-otono');
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
  });
});
