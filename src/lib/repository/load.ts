import { eventSchema } from '../schemas/event.ts';
import { organizerSchema } from '../schemas/organizer.ts';
import { seriesSchema } from '../schemas/series.ts';
import { sourceSchema } from '../schemas/source.ts';
import { venueSchema } from '../schemas/venue.ts';
import { validateRawFiles } from '../validation/validate-dir.ts';
import { emptyCatalog, type Catalog } from '../domain/catalog.ts';
import { defaultDataDir, readRawCatalogFiles } from './fs.ts';
import type { RawEntityFile } from './fs.ts';

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

let publishedCatalog: { dir: string; catalog: Promise<Catalog> } | null = null;

/**
 * Carga el catálogo de DATA_DIR (o `data/`). Queda memoizado durante el proceso
 * para que el build de Astro no relea y revalide en cada página.
 *
 * Los tests que necesiten otro árbol deben usar `loadCatalogFromDir`.
 */
export async function loadPublishedCatalog(): Promise<Catalog> {
  const dir = defaultDataDir();
  if (publishedCatalog?.dir === dir) {
    return publishedCatalog.catalog;
  }
  const catalog = loadCatalogFromDir(dir);
  publishedCatalog = { dir, catalog };
  return catalog;
}

/** Vacía la caché del catálogo publicado. Pensado para tests. */
export function clearPublishedCatalogCache(): void {
  publishedCatalog = null;
}

export async function loadCatalogFromDir(rootDir: string): Promise<Catalog> {
  const files = await readRawCatalogFiles(rootDir);
  const report = validateRawFiles(files);
  if (!report.ok) {
    const details = report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.path ?? '?'}: ${issue.message}`)
      .join('\n');
    throw new CatalogValidationError(`Catálogo inválido:\n${details}`);
  }
  return parseCatalog(files);
}

function parseCatalog(files: RawEntityFile[]): Catalog {
  const catalog = emptyCatalog();
  for (const file of files) {
    const value: unknown = JSON.parse(file.raw);
    switch (file.collection) {
      case 'events':
        catalog.events.push(eventSchema.parse(value));
        break;
      case 'venues':
        catalog.venues.push(venueSchema.parse(value));
        break;
      case 'organizers':
        catalog.organizers.push(organizerSchema.parse(value));
        break;
      case 'series':
        catalog.series.push(seriesSchema.parse(value));
        break;
      case 'sources':
        catalog.sources.push(sourceSchema.parse(value));
        break;
    }
  }
  return catalog;
}
