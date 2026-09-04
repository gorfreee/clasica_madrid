import type { Era } from '../../lib/schemas/taxonomies.ts';
import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import type { ObservedFacts } from '../observed.ts';
import { foldName, hasPhrase } from './text.ts';
import type { Resolution } from './types.ts';

const ERA_ORDER: Era[] = [
  'early',
  'renaissance',
  'baroque',
  'classical',
  'romantic',
  'twentieth',
  'contemporary',
];

/**
 * Evidence order: works[].composerName, then composers[], then names
 * explicitly present in programText / description. No venue or ensemble.
 */
export function resolveEras(facts: ObservedFacts): Resolution<Era[]> {
  const fromWorks = erasFromNames(
    facts.works.flatMap((work) => (work.composerName ? [work.composerName] : [])),
  );
  if (fromWorks.eras.length > 0) {
    return {
      value: fromWorks.eras,
      method: 'knowledge',
      ruleId: 'eras-from-works',
      evidence: fromWorks.evidence,
    };
  }

  const fromComposers = erasFromNames(facts.composers.map((item) => item.name));
  if (fromComposers.eras.length > 0) {
    return {
      value: fromComposers.eras,
      method: 'knowledge',
      ruleId: 'eras-from-composers',
      evidence: fromComposers.evidence,
    };
  }

  if (declaresContemporaryEra(facts)) {
    return {
      value: ['contemporary'],
      method: 'rule',
      ruleId: 'eras-declared-contemporary',
      evidence: [facts.categoryText ?? facts.title],
    };
  }

  const programme = [facts.programText, facts.description].filter(Boolean).join('\n');
  const mentioned = findKnownComposersInText(programme);
  if (mentioned.length > 0) {
    const eras = new Set<Era>();
    const evidence: string[] = [];
    for (const item of mentioned) {
      evidence.push(`${item.canonicalName} (${item.eras.join(', ')})`);
      for (const era of item.eras) eras.add(era);
    }
    return {
      value: ERA_ORDER.filter((era) => eras.has(era)),
      method: 'knowledge',
      ruleId: 'eras-from-program-text',
      evidence,
    };
  }

  return {
    value: [],
    method: 'fallback',
    ruleId: 'eras-unknown',
    evidence: [],
  };
}

function erasFromNames(names: string[]): { eras: Era[]; evidence: string[] } {
  const eras = new Set<Era>();
  const evidence: string[] = [];
  for (const name of names) {
    const match = matchComposer(name);
    if (!match) continue;
    evidence.push(`${name} → ${match.canonicalName} (${match.eras.join(', ')})`);
    for (const era of match.eras) eras.add(era);
  }
  return { eras: ERA_ORDER.filter((era) => eras.has(era)), evidence };
}

function declaresContemporaryEra(facts: ObservedFacts): boolean {
  const title = foldName(facts.title);
  const category = foldName(facts.categoryText ?? '');
  const series = foldName(facts.seriesText ?? '');
  return [title, category, series].some(
    (text) =>
      hasPhrase(text, 'musica contemporanea') ||
      hasPhrase(text, 'festival coma') ||
      hasPhrase(text, 'coma 26'),
  );
}
