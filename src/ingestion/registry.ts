import type { Catalog } from '../lib/domain/catalog.ts';
import type { Source } from '../lib/schemas/index.ts';
import { auditorioNacionalAdapter } from './sources/auditorio-nacional.ts';
import { madridDatosAdapter } from './sources/madrid-datos.ts';
import { teatroRealAdapter } from './sources/teatro-real.ts';
import { teatroZarzuelaAdapter } from './sources/teatro-zarzuela.ts';
import { fundacionJuanMarchAdapter } from './sources/fundacion-juan-march.ts';
import type { SourceAdapter, SourceDefinition } from './types.ts';

const ADAPTERS: Record<string, SourceAdapter> = {
  [fundacionJuanMarchAdapter.id]: fundacionJuanMarchAdapter,
  [auditorioNacionalAdapter.id]: auditorioNacionalAdapter,
  [teatroRealAdapter.id]: teatroRealAdapter,
  [madridDatosAdapter.id]: madridDatosAdapter,
  [teatroZarzuelaAdapter.id]: teatroZarzuelaAdapter,
};

const srcAuditorio: Source = {
  schemaVersion: 1,
  id: 'src_auditorio_nacional',
  slug: 'auditorio-nacional-de-musica',
  name: 'Auditorio Nacional de Música',
  kind: 'official',
  url: 'https://auditorionacional.inaem.gob.es/es',
};

const srcTeatroReal: Source = {
  schemaVersion: 1,
  id: 'src_teatro_real',
  slug: 'teatro-real',
  name: 'Teatro Real',
  kind: 'official',
  url: 'https://www.teatroreal.es/es',
};

const srcAyuntamiento: Source = {
  schemaVersion: 1,
  id: 'src_ayuntamiento_madrid',
  slug: 'ayuntamiento-de-madrid',
  name: 'Ayuntamiento de Madrid',
  kind: 'official',
  url: 'https://www.madrid.es/',
};

export const SOURCE_REGISTRY: SourceDefinition[] = [
  {
    id: 'auditorio-nacional',
    name: 'Auditorio Nacional de Música',
    urls: ['https://auditorionacional.inaem.gob.es/front-page-events.json'],
    adapterId: auditorioNacionalAdapter.id,
    catalogSourceId: srcAuditorio.id,
    seedSource: srcAuditorio,
  },
  {
    id: 'teatro-real',
    name: 'Teatro Real',
    urls: ['https://www.teatroreal.es/es/calendario'],
    adapterId: teatroRealAdapter.id,
    catalogSourceId: srcTeatroReal.id,
    seedSource: srcTeatroReal,
  },
  {
    id: 'madrid-datos',
    name: 'Datos abiertos del Ayuntamiento de Madrid',
    urls: ['https://datos.madrid.es/egob/catalogo/206974-0-agenda-eventos-culturales-100.json'],
    adapterId: madridDatosAdapter.id,
    catalogSourceId: srcAyuntamiento.id,
    seedSource: srcAyuntamiento,
  },
  {
    id: 'teatro-zarzuela',
    name: 'Teatro de la Zarzuela',
    urls: ['https://teatrodelazarzuela.inaem.gob.es/es/'],
    adapterId: teatroZarzuelaAdapter.id,
    catalogSourceId: 'src_teatro_zarzuela',
    seedSource: {
      schemaVersion: 1,
      id: 'src_teatro_zarzuela',
      slug: 'teatro-de-la-zarzuela',
      name: 'Teatro de la Zarzuela',
      kind: 'official',
      url: 'https://teatrodelazarzuela.inaem.gob.es/',
    },
  },
  {
    id: 'fundacion-juan-march',
    name: 'Fundación Juan March',
    urls: ['https://www.march.es/es/madrid/conciertos'],
    adapterId: fundacionJuanMarchAdapter.id,
    catalogSourceId: 'src_fundacion_juan_march',
    skipDefaultSync: true,
    seedSource: {
      schemaVersion: 1,
      id: 'src_fundacion_juan_march',
      slug: 'fundacion-juan-march',
      name: 'Fundación Juan March',
      kind: 'official',
      url: 'https://www.march.es/',
    },
  },
];

export function listSourceDefinitions(): SourceDefinition[] {
  return SOURCE_REGISTRY;
}

export function getSourceDefinition(id: string): SourceDefinition {
  const source = SOURCE_REGISTRY.find((item) => item.id === id);
  if (!source) {
    const known = SOURCE_REGISTRY.map((item) => item.id).join(', ');
    throw new Error(`fuente desconocida: ${id}. Disponibles: ${known}`);
  }
  return source;
}

export function getAdapter(id: string): SourceAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`adapter desconocido: ${id}`);
  }
  return adapter;
}

export function resolveCatalogSource(source: SourceDefinition, catalog: Catalog): Source {
  return catalog.sources.find((item) => item.id === source.catalogSourceId) ?? source.seedSource;
}
