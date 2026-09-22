/** Live search waits until the query stops changing. Keystrokes inside the window do not emit. */
export const LIVE_SEARCH_DEBOUNCE_MS = 400;

export type LiveSearchState = {
  emittedQuery: string | null;
  pendingQuery: string | null;
  timerDue: number | null;
};

export function initialLiveSearchState(): LiveSearchState {
  return { emittedQuery: null, pendingQuery: null, timerDue: null };
}

/**
 * Records a new input value. Never emits: the caller flushes after the debounce.
 * An empty query cancels a pending emit and allows the same text to be searched again later.
 */
export function reduceLiveSearch(
  state: LiveSearchState,
  query: string,
  now: number,
  debounceMs = LIVE_SEARCH_DEBOUNCE_MS,
): LiveSearchState {
  if (!query) return initialLiveSearchState();
  if (query === state.emittedQuery && state.pendingQuery === null) return state;
  if (query === state.pendingQuery && state.timerDue !== null) return state;
  return {
    emittedQuery: state.emittedQuery,
    pendingQuery: query,
    timerDue: now + debounceMs,
  };
}

export function flushLiveSearch(
  state: LiveSearchState,
  now: number,
): { state: LiveSearchState; query: string | null } {
  if (state.timerDue === null || state.pendingQuery === null || now < state.timerDue) {
    return { state, query: null };
  }
  const query = state.pendingQuery;
  if (query === state.emittedQuery) {
    return { state: { emittedQuery: query, pendingQuery: null, timerDue: null }, query: null };
  }
  return {
    state: { emittedQuery: query, pendingQuery: null, timerDue: null },
    query,
  };
}

/**
 * Query that analytics may attribute to the list currently on screen.
 * `null` is the unfiltered list (first paint, or after the field is cleared).
 * `undefined` means a keystroke is still inside the debounce: do not measure
 * that intermediate result set. There is no second timer; this reads `reduceLiveSearch`.
 */
export function settledLiveSearchQuery(state: LiveSearchState): string | null | undefined {
  if (state.pendingQuery !== null) return undefined;
  return state.emittedQuery;
}
