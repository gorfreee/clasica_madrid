import { z } from 'zod';
import { ID_PREFIX, SCHEMA_VERSION } from './taxonomies.ts';
import { isRealIsoDate } from '../util/iso-date.ts';

export const schemaVersionSchema = z.literal(SCHEMA_VERSION);

const idTail = '([a-z0-9]+(_[a-z0-9]+)*)';

export const eventIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.event}${idTail}$`), 'ID de evento inválido (evt_…)');
export const venueIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.venue}${idTail}$`), 'ID de lugar inválido (ven_…)');
export const organizerIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.organizer}${idTail}$`), 'ID de organizador inválido (org_…)');
export const seriesIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.series}${idTail}$`), 'ID de serie inválido (ser_…)');
export const sourceIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.source}${idTail}$`), 'ID de fuente inválido (src_…)');
export const occurrenceIdSchema = z
  .string()
  .regex(new RegExp(`^${ID_PREFIX.occurrence}${idTail}$`), 'ID de representación inválido (occ_…)');

export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug debe ser kebab-case ASCII');

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha debe ser YYYY-MM-DD')
  .refine((value) => isRealIsoDate(value), 'fecha de calendario inválida');

export const isoTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora debe ser HH:mm (24h)');

export const httpUrlSchema = z
  .string()
  .url('URL inválida')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'la URL de fuente debe ser http o https');

export const nonEmptyStringSchema = z.string().trim().min(1).max(300);

export { isRealIsoDate };
