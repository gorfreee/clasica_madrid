import type { Era } from '../../lib/schemas/taxonomies.ts';
import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import type { ObservedFacts } from '../observed.ts';
import { foldName, foldText, hasPhrase } from './text.ts';
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
 * Declared-era subjects: the source is naming the repertoire of this event,
 * not mentioning an era in a biography, book title or promotional flourish.
 * Adjective forms ("románticos") and bare era words are intentionally omitted.
 */
const DECLARED_ERA_SUBJECT = String.raw`(?:compositor(?:a|es|as)?|obras?|repertorio|musica)`;
const DECLARED_PROGRAMME_ERAS: Array<{ era: Era; label: string }> = [
  { era: 'renaissance', label: 'renacimiento' },
  { era: 'baroque', label: 'barroco' },
  { era: 'classical', label: 'clasicismo' },
  { era: 'romantic', label: 'romanticismo' },
];

/**
 * Evidence order: works[].composerName, then composers[], then names
 * explicitly present in programText. Editorial description is not scanned
 * for composer names. A later conservative rule may still read an unambiguous
 * repertoire-era declaration such as "compositores del Romanticismo".
 * No venue or ensemble.
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

  const mentioned = facts.programText ? findKnownComposersInText(facts.programText) : [];
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

  const declared = declaredProgrammeEras(facts);
  if (declared) return declared;

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

function declaredProgrammeEras(facts: ObservedFacts): Resolution<Era[]> | undefined {
  const fields = [facts.programText, facts.title, facts.categoryText, facts.seriesText, facts.description];
  const eras = new Set<Era>();
  const evidence: string[] = [];
  for (const field of fields) {
    if (!field) continue;
    const folded = foldText(field);
    for (const { era, label } of DECLARED_PROGRAMME_ERAS) {
      const match = declaredEraPattern(label).exec(folded);
      if (!match?.[1]) continue;
      eras.add(era);
      evidence.push(match[1].trim());
    }
  }
  if (eras.size === 0) return undefined;
  return {
    value: ERA_ORDER.filter((era) => eras.has(era)),
    method: 'rule',
    ruleId: 'eras-declared-programme',
    evidence,
  };
}

function declaredEraPattern(label: string): RegExp {
  return new RegExp(`(?:^|[^a-z0-9])(${DECLARED_ERA_SUBJECT}\\s+del?\\s+${label})(?:[^a-z0-9]|$)`);
}
