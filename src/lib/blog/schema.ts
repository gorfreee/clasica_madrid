import { z } from 'zod';
import { httpUrlSchema, slugSchema } from '../schemas/common.ts';
import { isRealIsoDate } from '../util/iso-date.ts';

/** Stable editorial taxonomy. Public kind and tag pages are intentionally absent. */
export const BLOG_KINDS = ['temporada', 'guia', 'critica', 'actualidad', 'otro'] as const;

export type BlogKind = (typeof BLOG_KINDS)[number];

export const blogKindLabels: Record<BlogKind, string> = {
  temporada: 'Temporada',
  guia: 'Guía',
  critica: 'Crítica',
  actualidad: 'Actualidad',
  otro: 'Nota',
};

/**
 * Calendar day for frontmatter. Accepts `YYYY-MM-DD` and the UTC-midnight
 * timestamp Astro's YAML parser produces for an unquoted date. Other times
 * are rejected so a timezone shift cannot move the publication day.
 */
export function calendarIso(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    if (
      value.getUTCHours() !== 0 ||
      value.getUTCMinutes() !== 0 ||
      value.getUTCSeconds() !== 0 ||
      value.getUTCMilliseconds() !== 0
    ) {
      return null;
    }
    return utcDay(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isRealIsoDate(trimmed)) return trimmed;
  const stamp = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(trimmed);
  if (!stamp?.[1] || !isRealIsoDate(stamp[1])) return null;
  return stamp[1];
}

export const blogDateSchema = z.unknown().transform((value, ctx) => {
  const iso = calendarIso(value);
  if (!iso) {
    ctx.addIssue({ code: 'custom', message: 'fecha debe ser YYYY-MM-DD' });
    return z.NEVER;
  }
  return iso;
});

export function blogEntrySchema<T extends z.ZodType>(heroImage: T) {
  return z
    .object({
      title: z.string().trim().min(1).max(180),
      description: z.string().trim().min(1).max(300),
      publishedAt: blogDateSchema,
      updatedAt: blogDateSchema.optional(),
      kind: z.enum(BLOG_KINDS),
      heroImage,
      heroAlt: z.string().trim().min(1).max(300),
      heroCaption: z.string().trim().min(1).max(300).optional(),
      heroCredit: z.string().trim().min(1).max(180).optional(),
      heroCreditUrl: httpUrlSchema.optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
      relatedVenues: z.array(slugSchema).max(8).default([]),
      featured: z.boolean().default(false),
      draft: z.boolean().default(false),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.updatedAt && data.updatedAt < data.publishedAt) {
        ctx.addIssue({
          code: 'custom',
          message: 'updatedAt no puede ser anterior a publishedAt',
          path: ['updatedAt'],
        });
      }
      if (data.heroCreditUrl && !data.heroCredit) {
        ctx.addIssue({
          code: 'custom',
          message: 'heroCreditUrl exige heroCredit',
          path: ['heroCreditUrl'],
        });
      }
      const tags = data.tags.map((tag) => tag.toLocaleLowerCase('es'));
      if (new Set(tags).size !== tags.length) {
        ctx.addIssue({ code: 'custom', message: 'tags duplicadas', path: ['tags'] });
      }
      if (new Set(data.relatedVenues).size !== data.relatedVenues.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'relatedVenues duplicados',
          path: ['relatedVenues'],
        });
      }
    });
}

export function assertBlogSlug(id: string): void {
  const parsed = slugSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(`El archivo del artículo no es un slug válido: ${id}`);
  }
}

function utcDay(value: Date): string | null {
  const iso = `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  return isRealIsoDate(iso) ? iso : null;
}
