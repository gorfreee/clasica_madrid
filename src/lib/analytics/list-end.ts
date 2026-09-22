import { trackResultListExhausted, type AnalyticsSurface } from './product.ts';

export type ListObservation = {
  surface: Extract<AnalyticsSurface, 'agenda' | 'venues' | 'venue'>;
  results_count: number;
  active_filter_count: number;
  has_search_query: boolean;
  quick_filter?: string;
  /** In-memory identity of the result set. Not sent to PostHog. */
  stateKey: string;
};

type Session = {
  anchor: HTMLElement;
  sentinel: HTMLElement;
  observer: IntersectionObserver;
  observation: ListObservation;
};

const sessions = new WeakMap<HTMLElement, Session>();
const seen = new Set<string>();

export function listExhaustionKey(observation: ListObservation): string {
  return [observation.surface, observation.stateKey, String(observation.results_count)].join('\u0000');
}

/** One admission per result-set key for this document. The set is memory only. */
export function claimListExhaustion(gate: Set<string>, observation: ListObservation): boolean {
  if (observation.results_count <= 0) return false;
  const key = listExhaustionKey(observation);
  if (gate.has(key)) return false;
  gate.add(key);
  return true;
}

/**
 * Watches a 1px sentinel at the end of `anchor`. Rebinding the same anchor
 * updates the snapshot. A result set that is already on screen counts once;
 * scrolling away and back does not count again. Filter changes use a new key.
 */
export function syncResultsEnd(anchor: HTMLElement, options: { enabled: boolean; observation: ListObservation }): void {
  if (!options.enabled || typeof IntersectionObserver === 'undefined') {
    clearSession(anchor);
    return;
  }
  let session = sessions.get(anchor);
  if (!session || !anchor.contains(session.sentinel)) {
    clearSession(anchor);
    const sentinel = ensureSentinel(anchor);
    session = {
      anchor,
      sentinel,
      observation: options.observation,
      observer: new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          const current = sessions.get(anchor);
          if (current) publish(current.observation);
        },
        { threshold: 0 },
      ),
    };
    session.observer.observe(sentinel);
    sessions.set(anchor, session);
  }
  session.observation = options.observation;
  publishIfVisible(session);
}

export function initMarkedResultsLists(root: ParentNode = document): void {
  for (const anchor of root.querySelectorAll<HTMLElement>('[data-results-surface]')) {
    if (anchor.dataset.resultsBound === 'true') continue;
    const surface = anchor.dataset.resultsSurface;
    if (surface !== 'agenda' && surface !== 'venues' && surface !== 'venue') continue;
    anchor.dataset.resultsBound = 'true';
    const count = anchor.querySelectorAll('[data-occurrence-id], [data-venue-entry]').length;
    syncResultsEnd(anchor, {
      enabled: count > 0,
      observation: {
        surface,
        results_count: count,
        active_filter_count: 0,
        has_search_query: false,
        quick_filter: anchor.dataset.quickFilter || undefined,
        stateKey: anchor.dataset.quickFilter || 'static',
      },
    });
  }
}

function publishIfVisible(session: Session): void {
  const rect = session.sentinel.getBoundingClientRect();
  const visible = rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  if (!visible) return;
  publish(session.observation);
}

function publish(observation: ListObservation): void {
  if (!claimListExhaustion(seen, observation)) return;
  trackResultListExhausted({
    surface: observation.surface,
    results_count: observation.results_count,
    active_filter_count: observation.active_filter_count,
    has_search_query: observation.has_search_query,
    quick_filter: observation.quick_filter,
  });
}

function ensureSentinel(anchor: HTMLElement): HTMLElement {
  const existing = anchor.querySelector<HTMLElement>(':scope > [data-results-end]');
  if (existing) return existing;
  const sentinel = document.createElement('div');
  sentinel.dataset.resultsEnd = '';
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.height = '1px';
  sentinel.style.overflow = 'hidden';
  anchor.append(sentinel);
  return sentinel;
}

function clearSession(anchor: HTMLElement): void {
  const session = sessions.get(anchor);
  if (!session) return;
  session.observer.disconnect();
  session.sentinel.remove();
  sessions.delete(anchor);
}
