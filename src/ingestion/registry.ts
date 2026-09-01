import type { Catalog } from '../lib/domain/catalog.ts';
import type { Source } from '../lib/schemas/index.ts';
import { auditorioNacionalAdapter } from './sources/auditorio-nacional.ts';
import { madridDatosAdapter } from './sources/madrid-datos.ts';
import { teatroRealAdapter } from './sources/teatro-real.ts';
import { teatroZarzuelaAdapter } from './sources/teatro-zarzuela.ts';
import { fundacionJuanMarchAdapter } from './sources/fundacion-juan-march.ts';
import { fundacionCanalAdapter } from './sources/fundacion-canal.ts';
import { fundacionOrcamAdapter } from './sources/fundacion-orcam.ts';
import { orquestaCoroRtveAdapter } from './sources/orquesta-coro-rtve.ts';
import { teatrosCanalAdapter } from './sources/teatros-canal.ts';
import { circuloBellasArtesAdapter } from './sources/circulo-bellas-artes.ts';
import { cndmAdapter } from './sources/cndm.ts';
import { basilicaSanMiguelAdapter } from './sources/basilica-san-miguel.ts';
import { fundacionPiuMossoAdapter } from './sources/fundacion-piu-mosso.ts';
import type { PipelineSource, SourceAdapter, SourceDefinition } from './types.ts';

const ADAPTERS: Record<string, SourceAdapter> = {
  [orquestaCoroRtveAdapter.id]: orquestaCoroRtveAdapter,
  [fundacionCanalAdapter.id]: fundacionCanalAdapter,
  [circuloBellasArtesAdapter.id]: circuloBellasArtesAdapter,
  [fundacionOrcamAdapter.id]: fundacionOrcamAdapter,
  [fundacionJuanMarchAdapter.id]: fundacionJuanMarchAdapter,
  [auditorioNacionalAdapter.id]: auditorioNacionalAdapter,
  [teatroRealAdapter.id]: teatroRealAdapter,
  [madridDatosAdapter.id]: madridDatosAdapter,
  [teatroZarzuelaAdapter.id]: teatroZarzuelaAdapter,
  [teatrosCanalAdapter.id]: teatrosCanalAdapter,
  [cndmAdapter.id]: cndmAdapter,
  [basilicaSanMiguelAdapter.id]: basilicaSanMiguelAdapter,
  [fundacionPiuMossoAdapter.id]: fundacionPiuMossoAdapter,
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
    useFetchRelay: true,
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
    useFetchRelay: true,
    seedSource: {
      schemaVersion: 1,
      id: 'src_fundacion_juan_march',
      slug: 'fundacion-juan-march',
      name: 'Fundación Juan March',
      kind: 'official',
      url: 'https://www.march.es/',
    },
  },
  {
    id: 'fundacion-orcam',
    name: 'Fundación ORCAM',
    urls: ['https://fundacionorcam.org/programacion/'],
    adapterId: fundacionOrcamAdapter.id,
    catalogSourceId: 'src_fundacion_orcam',
    seedSource: {
      schemaVersion: 1,
      id: 'src_fundacion_orcam',
      slug: 'fundacion-orcam',
      name: 'Fundación ORCAM',
      kind: 'official',
      url: 'https://fundacionorcam.org/',
    },
  },
  {
    id: 'orquesta-coro-rtve',
    name: 'Orquesta y Coro RTVE / Teatro Monumental',
    urls: ['https://www.teatromonumental.es/'],
    adapterId: orquestaCoroRtveAdapter.id,
    catalogSourceId: 'src_orquesta_coro_rtve',
    seedSource: {
      schemaVersion: 1,
      id: 'src_orquesta_coro_rtve',
      slug: 'orquesta-y-coro-rtve',
      name: 'Orquesta y Coro RTVE / Teatro Monumental',
      kind: 'official',
      url: 'https://www.teatromonumental.es/',
    },
  },
  {
    id: 'teatros-canal',
    name: 'Teatros del Canal',
    urls: ['https://www.teatroscanal.com/wp-json/tribe/events/v1/events'],
    adapterId: teatrosCanalAdapter.id,
    catalogSourceId: 'src_teatros_canal',
    seedSource: {
      schemaVersion: 1,
      id: 'src_teatros_canal',
      slug: 'teatros-del-canal',
      name: 'Teatros del Canal',
      kind: 'official',
      url: 'https://www.teatroscanal.com/',
    },
  },
  {
    id: 'fundacion-canal',
    name: 'Fundación Canal',
    urls: [
      'https://www.fundacioncanal.com/ciclo-musica-camara/',
      'https://www.fundacioncanal.com/ciclo-musica-en-familia/proximas/',
      'https://www.fundacioncanal.com/otros-conciertos/proximas/',
    ],
    adapterId: fundacionCanalAdapter.id,
    catalogSourceId: 'src_fundacion_canal',
    seedSource: {
      schemaVersion: 1,
      id: 'src_fundacion_canal',
      slug: 'fundacion-canal',
      name: 'Fundación Canal',
      kind: 'official',
      url: 'https://www.fundacioncanal.com/',
    },
  },
  {
    id: 'circulo-bellas-artes',
    name: 'Círculo de Bellas Artes',
    urls: [
      'https://www.circulobellasartes.com/eventos/',
      'https://www.circulobellasartes.com/espectaculos/',
    ],
    adapterId: circuloBellasArtesAdapter.id,
    catalogSourceId: 'src_circulo_bellas_artes',
    seedSource: {
      schemaVersion: 1,
      id: 'src_circulo_bellas_artes',
      slug: 'circulo-de-bellas-artes',
      name: 'Círculo de Bellas Artes',
      kind: 'official',
      url: 'https://www.circulobellasartes.com/',
    },
  },
  {
    id: 'cndm',
    name: 'Centro Nacional de Difusión Musical',
    urls: ['https://cndm.inaem.gob.es/'],
    adapterId: cndmAdapter.id,
    catalogSourceId: 'src_cndm',
    seedSource: {
      schemaVersion: 1,
      id: 'src_cndm',
      slug: 'centro-nacional-de-difusion-musical',
      name: 'Centro Nacional de Difusión Musical',
      kind: 'official',
      url: 'https://cndm.inaem.gob.es/',
    },
  },
  {
    id: 'basilica-san-miguel',
    name: 'Basílica Pontificia de San Miguel',
    urls: ['https://basilicadesanmiguel.org/wp-json/tribe/events/v1/events'],
    adapterId: basilicaSanMiguelAdapter.id,
    catalogSourceId: 'src_basilica_san_miguel',
    seedSource: {
      schemaVersion: 1,
      id: 'src_basilica_san_miguel',
      slug: 'basilica-pontificia-de-san-miguel',
      name: 'Basílica Pontificia de San Miguel',
      kind: 'official',
      url: 'https://basilicadesanmiguel.org/',
    },
  },
  {
    id: 'fundacion-piu-mosso',
    name: 'Fundación Più Mosso',
    urls: ['https://www.fundacionpiumosso.com/programacion/'],
    adapterId: fundacionPiuMossoAdapter.id,
    catalogSourceId: 'src_fundacionpiumosso_com',
    seedSource: {
      schemaVersion: 1,
      id: 'src_fundacionpiumosso_com',
      slug: 'fundacion-piu-mosso',
      name: 'Fundación Più Mosso',
      kind: 'official',
      url: 'https://www.fundacionpiumosso.com/',
    },
  },
];

export function listSourceDefinitions(): SourceDefinition[] {
  return SOURCE_REGISTRY;
}

/** Listing hostnames of sources with `useFetchRelay`. The Worker has no copy of this list. */
export function fetchRelayHosts(sources: readonly SourceDefinition[] = SOURCE_REGISTRY): string[] {
  const hosts = new Set<string>();
  for (const source of sources) {
    if (!source.useFetchRelay) continue;
    for (const url of source.urls) {
      try {
        const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        if (host) hosts.add(host);
      } catch {
        // ignore unparseable listing URLs; extraction will fail that source
      }
    }
  }
  return [...hosts].sort();
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

export function resolveCatalogSource(source: PipelineSource, catalog: Catalog): Source {
  return catalog.sources.find((item) => item.id === source.catalogSourceId) ?? source.seedSource;
}
