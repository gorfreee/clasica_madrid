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

export type DiscoveryResearchCoverageStatus = 'adequate' | 'review';

export type DiscoveryResearchCoverageReasonCode =
  | 'manifest-missing'
  | 'window-months-not-declared'
  | 'window-months-missing'
  | 'high-recall-pass-missing'
  | 'long-tail-pass-missing'
  | 'music-vocabulary-pass-missing'
  | 'low-yield-recovery-missing'
  | 'high-redundancy-recovery-missing';

export type DiscoveryResearchCoverageReason = {
  code: DiscoveryResearchCoverageReasonCode;
  message: string;
};

export type DiscoveryResearchCoverage = {
  status: DiscoveryResearchCoverageStatus;
  reasons: DiscoveryResearchCoverageReason[];
  candidatesReviewedApprox: number;
  submittedObservations: number;
  approximateYieldPercent?: number;
  redundantCandidates: number;
  redundantPercent?: number;
  searchPasses: string[];
  expectedMonths: string[];
  searchedMonths: string[];
  missingMonths: string[];
};

const LOW_YIELD_MIN_CANDIDATES = 40;
const LOW_YIELD_MAX_OBSERVATIONS = 4;
const HIGH_REDUNDANCY_MIN_CANDIDATES = 20;
const HIGH_REDUNDANCY_MIN_COUNT = 20;
const HIGH_REDUNDANCY_RATIO = 0.7;

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

/**
 * Audit signal for the manual research strategy. It is deliberately separate
 * from pipeline health and never changes eligibility or publication.
 */
export function assessDiscoveryResearchCoverage(
  research: DiscoveryResearchManifest | undefined,
  observationCount: number,
  window: IngestWindow,
): DiscoveryResearchCoverage {
  const expectedMonths = civilMonthsInWindow(window);
  if (!research) {
    return {
      status: 'review',
      reasons: [
        {
          code: 'manifest-missing',
          message: 'falta DiscoveryResearchManifest; la estrategia de investigación no es auditable',
        },
      ],
      candidatesReviewedApprox: 0,
      submittedObservations: observationCount,
      redundantCandidates: 0,
      searchPasses: [],
      expectedMonths,
      searchedMonths: [],
      missingMonths: expectedMonths,
    };
  }

  const reasons: DiscoveryResearchCoverageReason[] = [];
  const searchedMonths = research.windowMonthsSearched ?? [];
  const searchedSet = new Set(searchedMonths);
  const missingMonths = expectedMonths.filter((month) => !searchedSet.has(month));
  if (!research.windowMonthsSearched) {
    reasons.push({
      code: 'window-months-not-declared',
      message: 'no se declaran los meses civiles explorados',
    });
  } else if (missingMonths.length > 0) {
    reasons.push({
      code: 'window-months-missing',
      message: `faltan meses civiles de la ventana: ${missingMonths.join(', ')}`,
    });
  }

  const searchPasses = research.searchPasses?.map((pass) => pass.kind) ?? [];
  const passKinds = new Set(searchPasses);
  const requiredPasses = [
    ['high-recall', 'high-recall-pass-missing', 'no se declara una pasada de superficies de alto recall'],
    ['long-tail', 'long-tail-pass-missing', 'no se declara una pasada long-tail por ecosistemas'],
    ['music-vocabulary', 'music-vocabulary-pass-missing', 'no se declara una pasada por vocabulario musical'],
  ] as const;
  for (const [kind, code, message] of requiredPasses) {
    if (!passKinds.has(kind)) reasons.push({ code, message });
  }

  const candidates = research.candidatesReviewedApprox;
  const submitted = observationCount;
  const approximateYieldPercent = candidates > 0 ? roundPercent(submitted / candidates) : undefined;
  const redundantCandidates = exclusionCount(research, 'already-covered') + exclusionCount(research, 'harvested-source');
  const redundantRatio = candidates > 0 ? redundantCandidates / candidates : undefined;
  const redundantPercent = redundantRatio === undefined ? undefined : roundPercent(redundantRatio);
  const recoveryDeclared = passKinds.has('recovery');

  if (
    candidates >= LOW_YIELD_MIN_CANDIDATES &&
    submitted <= LOW_YIELD_MAX_OBSERVATIONS &&
    !recoveryDeclared
  ) {
    reasons.push({
      code: 'low-yield-recovery-missing',
      message: `yield bajo (${submitted}/${candidates}) sin una pasada adicional de recuperación`,
    });
  }

  if (
    candidates >= HIGH_REDUNDANCY_MIN_CANDIDATES &&
    redundantCandidates >= HIGH_REDUNDANCY_MIN_COUNT &&
    redundantRatio !== undefined &&
    redundantRatio >= HIGH_REDUNDANCY_RATIO &&
    !recoveryDeclared
  ) {
    reasons.push({
      code: 'high-redundancy-recovery-missing',
      message: `trabajo redundante muy alto (${redundantCandidates}/${candidates}) sin diversificación posterior`,
    });
  }

  return {
    status: reasons.length === 0 ? 'adequate' : 'review',
    reasons,
    candidatesReviewedApprox: candidates,
    submittedObservations: submitted,
    ...(approximateYieldPercent === undefined ? {} : { approximateYieldPercent }),
    redundantCandidates,
    ...(redundantPercent === undefined ? {} : { redundantPercent }),
    searchPasses,
    expectedMonths,
    searchedMonths,
    missingMonths,
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

function exclusionCount(
  research: DiscoveryResearchManifest,
  reason: DiscoveryResearchManifest['exclusions'][number]['reason'],
): number {
  return research.exclusions
    .filter((item) => item.reason === reason)
    .reduce((total, item) => total + item.count, 0);
}

function roundPercent(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}
