import type { Catalog } from '../domain/catalog.ts';
import { errorIssue, warningIssue, type ValidationIssue } from './report.ts';
import { isMadridMunicipality, normalizeText } from '../domain/normalize.ts';
import { isRealIsoDate } from '../schemas/common.ts';

export function findReferenceIssues(catalog: Catalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const venues = indexById(catalog.venues);
  const organizers = indexById(catalog.organizers);
  const series = indexById(catalog.series);
  const sources = indexById(catalog.sources);
  const occurrenceIds = new Set<string>();

  issues.push(...findDuplicateIds('venues', catalog.venues.map((item) => item.id)));
  issues.push(...findDuplicateIds('organizers', catalog.organizers.map((item) => item.id)));
  issues.push(...findDuplicateIds('series', catalog.series.map((item) => item.id)));
  issues.push(...findDuplicateIds('sources', catalog.sources.map((item) => item.id)));
  issues.push(...findDuplicateIds('events', catalog.events.map((item) => item.id)));

  issues.push(...findDuplicateSlugs('venues', catalog.venues.map((item) => ({ id: item.id, slug: item.slug }))));
  issues.push(...findDuplicateSlugs('organizers', catalog.organizers.map((item) => ({ id: item.id, slug: item.slug }))));
  issues.push(...findDuplicateSlugs('series', catalog.series.map((item) => ({ id: item.id, slug: item.slug }))));
  issues.push(...findDuplicateSlugs('sources', catalog.sources.map((item) => ({ id: item.id, slug: item.slug }))));
  issues.push(...findDuplicateSlugs('events', catalog.events.map((item) => ({ id: item.id, slug: item.slug }))));

  for (const venue of catalog.venues) {
    const madrid = isMadridMunicipality(venue.municipality);
    if (madrid && venue.area !== 'madrid') {
      issues.push(
        errorIssue(
          'area-mismatch',
          `el municipio Madrid debe usar area "madrid"`,
          `venues/${venue.id}.json`,
        ),
      );
    }
    if (!madrid && venue.area === 'madrid') {
      issues.push(
        errorIssue(
          'area-mismatch',
          `area "madrid" solo aplica al municipio de Madrid (recibido: ${venue.municipality})`,
          `venues/${venue.id}.json`,
        ),
      );
    }
  }

  for (const event of catalog.events) {
    const path = `events/${event.id}.json`;
    if (!venues.has(event.venueId)) {
      issues.push(errorIssue('missing-venue', `venueId inexistente: ${event.venueId}`, path));
    }
    if (event.seriesId && !series.has(event.seriesId)) {
      issues.push(errorIssue('missing-series', `seriesId inexistente: ${event.seriesId}`, path));
    }
    for (const organizerId of event.organizerIds) {
      if (!organizers.has(organizerId)) {
        issues.push(errorIssue('missing-organizer', `organizerId inexistente: ${organizerId}`, path));
      }
    }
    const uniqueOrganizers = new Set(event.organizerIds);
    if (uniqueOrganizers.size !== event.organizerIds.length) {
      issues.push(errorIssue('duplicate-organizer-ref', 'organizerIds contiene duplicados', path));
    }

    const uniqueEras = new Set(event.eras);
    if (uniqueEras.size !== event.eras.length) {
      issues.push(warningIssue('duplicate-era', 'eras contiene valores repetidos', path));
    }
    const uniqueFormats = new Set(event.formats);
    if (uniqueFormats.size !== event.formats.length) {
      issues.push(warningIssue('duplicate-format', 'formats contiene valores repetidos', path));
    }

    const occurrenceKeys = new Set<string>();
    for (const occurrence of event.occurrences) {
      if (occurrenceIds.has(occurrence.id)) {
        issues.push(errorIssue('duplicate-occurrence-id', `ID de representación duplicado: ${occurrence.id}`, path));
      }
      occurrenceIds.add(occurrence.id);
      if (!isRealIsoDate(occurrence.date)) {
        issues.push(errorIssue('impossible-date', `fecha imposible: ${occurrence.date}`, path));
      }
      const key = `${occurrence.date}|${occurrence.time ?? 'null'}`;
      if (occurrenceKeys.has(key)) {
        issues.push(
          errorIssue(
            'duplicate-occurrence',
            `el evento tiene dos representaciones con la misma fecha y hora (${occurrence.date} ${occurrence.time ?? 'sin hora'})`,
            path,
          ),
        );
      }
      occurrenceKeys.add(key);
      if (event.status === 'cancelled' && occurrence.status !== 'cancelled') {
        issues.push(
          errorIssue(
            'cancelled-event-active-occurrence',
            `evento cancelado con representación activa ${occurrence.id}`,
            path,
          ),
        );
      }
    }

    const citationSourceIds = new Set<string>();
    for (const citation of event.citations) {
      if (!sources.has(citation.sourceId)) {
        issues.push(errorIssue('missing-source', `sourceId inexistente: ${citation.sourceId}`, path));
      }
      citationSourceIds.add(citation.sourceId);
      if (citation.checkedAt > event.lastVerifiedAt) {
        issues.push(
          errorIssue(
            'verification-date',
            `checkedAt (${citation.checkedAt}) es posterior a lastVerifiedAt (${event.lastVerifiedAt})`,
            path,
          ),
        );
      }
    }
    if (!citationSourceIds.has(event.primarySourceId)) {
      issues.push(
        errorIssue(
          'primary-source',
          `primarySourceId ${event.primarySourceId} no está en citations`,
          path,
        ),
      );
    }

  }

  return issues;
}

function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function findDuplicateIds(collection: string, ids: string[]): ValidationIssue[] {
  const seen = new Map<string, number>();
  for (const id of ids) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const issues: ValidationIssue[] = [];
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push(errorIssue('duplicate-id', `ID duplicado en ${collection}: ${id}`, `${collection}/${id}.json`));
    }
  }
  return issues;
}

function findDuplicateSlugs(collection: string, items: { id: string; slug: string }[]): ValidationIssue[] {
  const seen = new Map<string, string[]>();
  for (const item of items) {
    const key = normalizeText(item.slug);
    const list = seen.get(key) ?? [];
    list.push(item.id);
    seen.set(key, list);
  }
  const issues: ValidationIssue[] = [];
  for (const [slug, ids] of seen) {
    if (ids.length > 1) {
      issues.push(
        errorIssue(
          'duplicate-slug',
          `slug duplicado en ${collection}: ${slug} (${ids.join(', ')})`,
          `${collection}/${ids[0]}.json`,
        ),
      );
    }
  }
  return issues;
}
