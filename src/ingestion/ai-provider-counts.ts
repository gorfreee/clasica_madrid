/**
 * Human summaries of provider activity. Membership comes from the routes
 * that were actually present in that run's pool, not from a hardcoded list.
 */
export type ProviderCountRoute = { provider: string };

export function completeProviderCounts(
  counts: Partial<Record<string, number>> | undefined,
  routes: readonly ProviderCountRoute[] | undefined,
): Record<string, number> {
  const completed: Record<string, number> = {};
  const seen = new Set<string>();

  for (const route of routes ?? []) {
    const provider = route.provider;
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    completed[provider] = counts?.[provider] ?? 0;
  }

  if (seen.size > 0) return completed;

  for (const [provider, value] of Object.entries(counts ?? {})) {
    completed[provider] = value ?? 0;
  }
  return completed;
}

export function formatProviderCountList(
  counts: Partial<Record<string, number>> | undefined,
  routes: readonly ProviderCountRoute[] | undefined,
  style: 'equals' | 'colon' = 'equals',
  empty = '',
): string {
  const completed = completeProviderCounts(counts, routes);
  const separator = style === 'colon' ? ': ' : '=';
  const formatted = Object.entries(completed)
    .map(([name, value]) => `${name}${separator}${value}`)
    .join(', ');
  return formatted || empty;
}
