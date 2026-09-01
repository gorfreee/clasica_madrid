import type {
  AccessMode,
  Area,
  Era,
  EventKind,
  Format,
  OccurrenceStatus,
  PerformerRole,
  SeriesKind,
  SourceKind,
} from '../schemas/taxonomies.ts';

export const areaLabels: Record<Area, string> = {
  madrid: 'Madrid',
  nearby: 'Alrededores',
};

export const accessLabels: Record<AccessMode, string> = {
  free: 'Gratuito',
  paid: 'De pago',
  unknown: 'Acceso no indicado',
};

export const eraLabels: Record<Era, string> = {
  early: 'Música antigua',
  renaissance: 'Renacimiento',
  baroque: 'Barroco',
  classical: 'Clasicismo',
  romantic: 'Romanticismo',
  twentieth: 'Siglo XX',
  contemporary: 'Contemporánea',
};

export const formatLabels: Record<Format, string> = {
  symphonic: 'Sinfónico',
  chamber: 'Cámara',
  recital: 'Recital',
  choral: 'Coral',
  organ: 'Órgano',
  'early-music': 'Música antigua',
  opera: 'Ópera',
  zarzuela: 'Zarzuela',
  lied: 'Lied / canción',
  other: 'Otros',
};

export const kindLabels: Record<EventKind, string> = {
  established: 'Establecido',
  alternative: 'Alternativo',
};

export const seriesKindLabels: Record<SeriesKind, string> = {
  festival: 'Festival',
  cycle: 'Ciclo',
  season: 'Temporada',
  series: 'Serie',
};

export const sourceKindLabels: Record<SourceKind, string> = {
  official: 'Oficial',
  aggregator: 'Agregador',
  secondary: 'Secundaria',
};

export const occurrenceStatusLabels: Record<OccurrenceStatus, string> = {
  scheduled: 'Programada',
  cancelled: 'Cancelada',
};

export const performerRoleLabels: Record<PerformerRole, string> = {
  orchestra: 'Orquesta',
  choir: 'Coro',
  ensemble: 'Ensemble',
  conductor: 'Dirección',
  soloist: 'Solista',
  other: 'Otros',
};

export function eventStatusLabel(status: 'scheduled' | 'cancelled' | 'postponed'): string {
  switch (status) {
    case 'scheduled':
      return 'Programado';
    case 'cancelled':
      return 'Cancelado';
    case 'postponed':
      return 'Aplazado';
  }
}

export function occurrenceCountLabel(count: number): string {
  return count === 1 ? '1 concierto' : `${count} conciertos`;
}
