#!/usr/bin/env npx tsx
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { listSourceDefinitions } from '../ingestion/registry.ts';
import { madridToday } from '../lib/domain/dates.ts';
import { writeCatalogWorkbook } from '../lib/export/catalog-workbook.ts';
import { loadPublishedCatalog } from '../lib/repository/load.ts';

const outputPath =
  process.argv[2] ?? path.join('exports', `clasica-madrid-${madridToday()}.xlsx`);

const catalog = await loadPublishedCatalog();
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeCatalogWorkbook(catalog, outputPath);

console.log(
  `Escrito: ${outputPath} (${catalog.events.length} eventos, ${catalog.venues.length} lugares, ${catalog.organizers.length} organizadores, ${catalog.series.length} series, ${catalog.sources.length} fuentes, ${listSourceDefinitions().length} adaptadores)`,
);
