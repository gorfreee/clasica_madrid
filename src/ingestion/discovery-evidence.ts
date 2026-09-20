import {
  type DiscoveryBatch,
  type DiscoveryObservation,
  type DiscoveryResearchManifest,
} from './discovery.ts';
import { civilMonthsInWindow, type IngestWindow } from './dates.ts';
import { sourceUrlKind, type SourceUrlKind } from './urls.ts';

export type DiscoveryEvidenceRichness = 'sparse' | 'partial' | 'rich';

export type DiscoveryEvidenceWarningReason = 'detail-url-sparse-evidence';

export type DiscoveryEvidenceWarning = {
  title: string;
  url: string;
  reason: DiscoveryEvidenceWarningReason;
};

export type DiscoveryObservationEvidence = {
  title: string;
  url: string;
  urlKind: SourceUrlKind;
  richness: DiscoveryEvidenceRichness;
  warning?: DiscoveryEvidenceWarningReason;
};

export type DiscoveryEvidenceDiagnostics = {
  observationCount: number;
  sparseCount: number;
  partialCount: number;
  richCount: number;
  listingUrlCount: number;
  detailUrlCount: number;
  detailUrlSparseCount: number;
  warnings: DiscoveryEvidenceWarning[];
};

/**
 * Heuristic review aid: a dedicated event ficha with only title/date/venue
 * often means the agent stopped at the listing card. Sparse listings and
 * genuinely thin official pages are not errors and never block publication.
 */
export function assessDiscoveryBatchEvidence(batch: DiscoveryBatch): DiscoveryEvidenceDiagnostics {
  const observations = batch.observations.map(assessObservationEvidence);
  const warnings = observations
    .filter((item) => item.warning)
    .map((item) => ({
      title: item.title,
      url: item.url,
      reason: item.warning!,
    }));

  return {
    observationCount: observations.length,
    sparseCount: observations.filter((item) => item.richness === 'sparse').length,
    partialCount: observations.filter((item) => item.richness === 'partial').length,
    richCount: observations.filter((item) => item.richness === 'rich').length,
    listingUrlCount: observations.filter((item) => item.urlKind === 'listing').length,
    detailUrlCount: observations.filter((item) => item.urlKind === 'event-detail').length,
    detailUrlSparseCount: observations.filter(
      (item) => item.urlKind === 'event-detail' && item.richness === 'sparse',
    ).length,
    warnings,
  };
}

export function discoveryResearchNotes(
  batch: DiscoveryBatch,
  research: DiscoveryResearchManifest | undefined,
  window?: IngestWindow,
): string[] {
  if (!research) {
    return [
      'sin DiscoveryResearchManifest: no se puede auditar la cobertura de la búsqueda previa al batch',
    ];
  }

  const notes: string[] = [];
  if (research.submittedToBatch !== batch.observations.length) {
    notes.push(
      `submittedToBatch (${research.submittedToBatch}) no coincide con observations.length (${batch.observations.length})`,
    );
  }
  if (research.officialDetailReviewed === 'none' && batch.observations.length > 0) {
    notes.push('el agente indica que no revisó fichas oficiales de detalle');
  }
  if (
    research.candidatesReviewedApprox === 0 &&
    batch.observations.length === 0 &&
    research.leads.length === 0
  ) {
    notes.push('el manifest no describe búsquedas ni candidatos revisados');
  }
  if (research.listingReviews === undefined) {
    notes.push(
      'sin listingReviews: no se puede auditar si una agenda/ciclo encontrada se recorrió por completo',
    );
  } else {
    const unresolvedListings = research.listingReviews.filter((item) => item.unresolved > 0);
    if (unresolvedListings.length > 0) {
      notes.push(
        `${unresolvedListings.length} listing(s) con candidatos en ventana sin resolver`,
      );
    }
    const submittedFromListings = research.listingReviews.reduce(
      (total, item) => total + item.submitted,
      0,
    );
    if (submittedFromListings > batch.observations.length) {
      notes.push(
        `listingReviews.submitted (${submittedFromListings}) supera observations.length (${batch.observations.length})`,
      );
    }
  }
  if (window && research.windowMonthsSearched) {
    const expected = civilMonthsInWindow(window);
    const searched = new Set(research.windowMonthsSearched);
    const missing = expected.filter((month) => !searched.has(month));
    if (missing.length > 0) {
      notes.push(`la investigación no declara cobertura de: ${missing.join(', ')}`);
    }
  }
  return notes;
}

export function assessObservationEvidence(
  observation: DiscoveryObservation,
): DiscoveryObservationEvidence {
  const url = observation.source.url;
  const urlKind = sourceUrlKind(url);
  const richness = observationEvidenceRichness(observation);
  return {
    title: observation.event.title,
    url,
    urlKind,
    richness,
    ...(urlKind === 'event-detail' && richness === 'sparse'
      ? { warning: 'detail-url-sparse-evidence' as const }
      : {}),
  };
}

function observationEvidenceRichness(observation: DiscoveryObservation): DiscoveryEvidenceRichness {
  const event = observation.event;
  const musical = [
    event.performers.length > 0,
    event.composers.length > 0,
    event.works.length > 0,
    Boolean(event.programText),
  ].filter(Boolean).length;
  const extra = [
    Boolean(event.description),
    Boolean(event.accessText),
    Boolean(event.organizerText),
    Boolean(event.seriesText),
    Boolean(event.categoryText),
  ].filter(Boolean).length;

  if (event.programText || musical >= 2) return 'rich';
  if (musical === 1 || extra >= 1) return 'partial';
  return 'sparse';
}
