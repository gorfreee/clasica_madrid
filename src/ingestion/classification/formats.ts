import type { Format } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts } from '../observed.ts';
import { fieldFolded, foldName, formatHaystack, hasPhrase, hasWord } from './text.ts';
import type { Resolution } from './types.ts';

const FORMAT_ORDER: Format[] = [
  'opera',
  'zarzuela',
  'symphonic',
  'choral',
  'chamber',
  'recital',
  'organ',
  'early-music',
  'lied',
  'other',
];

export function resolveFormats(facts: ObservedFacts): Resolution<Format[]> {
  const haystack = formatHaystack(facts);
  const hits: Array<{ format: Format; ruleId: string; evidence: string }> = [];

  if (isOperaFormat(facts, haystack)) {
    hits.push({ format: 'opera', ruleId: 'opera-format', evidence: facts.categoryText ?? facts.title });
  }
  if (isZarzuelaFormat(facts, haystack)) {
    hits.push({ format: 'zarzuela', ruleId: 'zarzuela-format', evidence: facts.title });
  }
  if (isOrganFormat(facts, haystack)) {
    hits.push({ format: 'organ', ruleId: 'organ-format', evidence: organEvidence(facts) });
  }
  if (isChoralFormat(facts, haystack)) {
    hits.push({ format: 'choral', ruleId: 'choral-format', evidence: choralEvidence(facts) });
  }
  if (isSymphonicFormat(facts, haystack)) {
    hits.push({ format: 'symphonic', ruleId: 'symphonic-format', evidence: orchestraEvidence(facts) });
  }
  if (isChamberFormat(facts, haystack)) {
    hits.push({ format: 'chamber', ruleId: 'chamber-format', evidence: chamberEvidence(facts) });
  }
  if (isRecitalFormat(facts, haystack, hits.map((item) => item.format))) {
    hits.push({ format: 'recital', ruleId: 'recital-format', evidence: recitalEvidence(facts) });
  }
  if (isEarlyMusicFormat(facts, haystack)) {
    hits.push({ format: 'early-music', ruleId: 'early-music-format', evidence: facts.categoryText ?? facts.title });
  }
  if (isLiedFormat(facts, haystack)) {
    hits.push({ format: 'lied', ruleId: 'lied-format', evidence: facts.title });
  }

  const unique = uniqueFormats(hits.map((item) => item.format));
  if (unique.length === 0) {
    return {
      value: [],
      method: 'fallback',
      ruleId: 'formats-insufficient',
      evidence: [],
    };
  }
  return {
    value: unique,
    method: 'rule',
    ruleId: hits[0]!.ruleId,
    evidence: [...new Set(hits.map((item) => item.evidence).filter(Boolean))],
  };
}

function isOperaFormat(facts: ObservedFacts, haystack: string): boolean {
  const category = fieldFolded(facts.categoryText);
  if (hasWord(category, 'taller')) return false;
  return (
    hasWord(category, 'opera') ||
    hasPhrase(haystack, 'arias de opera') ||
    hasPhrase(haystack, 'dramma lirico') ||
    hasPhrase(haystack, 'opera en') ||
    (hasWord(haystack, 'opera') && hasWord(haystack, 'actos'))
  );
}

function isZarzuelaFormat(facts: ObservedFacts, haystack: string): boolean {
  const category = fieldFolded(facts.categoryText);
  const title = fieldFolded(facts.title);
  return (
    hasWord(category, 'zarzuela') ||
    hasWord(title, 'zarzuela') ||
    hasPhrase(haystack, 'de zarzuelas') ||
    hasPhrase(haystack, 'zarzuela de')
  );
}

function isOrganFormat(facts: ObservedFacts, haystack: string): boolean {
  if (hasPhrase(haystack, 'conciertos de organo') || hasPhrase(haystack, 'recital de organo')) return true;
  return facts.performers.some((item) => hasWord(fieldFolded(item.roleText), 'organo'));
}

function isChoralFormat(facts: ObservedFacts, haystack: string): boolean {
  if (hasWord(haystack, 'oratorio')) return true;
  if (isNamedWorkEvent(facts)) return false;
  if (facts.performers.some((item) => hasWord(fieldFolded(item.roleText), 'coro'))) return true;
  return facts.performers.some((item) => /^coro\b/.test(fieldFolded(item.name)));
}

function isSymphonicFormat(facts: ObservedFacts, haystack: string): boolean {
  if (isNamedWorkEvent(facts)) return false;
  if (hasPhrase(haystack, 'orquesta y coro')) return true;
  if (hasPhrase(haystack, 'orquesta sinfonica') || hasWord(haystack, 'sinfonico')) {
    if (isChamberOrchestraName(haystack) && !hasWord(haystack, 'sinfonico')) return false;
    return true;
  }
  const orchestra = facts.performers.some((item) => {
    const role = fieldFolded(item.roleText);
    const name = fieldFolded(item.name);
    if (hasWord(role, 'orquesta') || hasWord(name, 'orquesta')) {
      return !hasWord(name, 'chamber') && !hasPhrase(name, 'camara');
    }
    return false;
  });
  return orchestra;
}

function isChamberFormat(facts: ObservedFacts, haystack: string): boolean {
  if (
    hasWord(haystack, 'cuarteto') ||
    hasWord(haystack, 'octeto') ||
    hasPhrase(haystack, 'liceo de camara') ||
    hasPhrase(haystack, 'domingos de camara') ||
    hasPhrase(haystack, 'musica de camara') ||
    hasPhrase(haystack, 'festival de ensembles')
  ) {
    return true;
  }
  if (facts.performers.some((item) => hasWord(fieldFolded(item.roleText), 'cuarteto'))) return true;
  return facts.performers.some((item) => hasPhrase(fieldFolded(item.name), 'chamber orchestra'));
}

function isRecitalFormat(facts: ObservedFacts, haystack: string, already: Format[]): boolean {
  if (hasWord(haystack, 'recital')) return true;
  if (already.includes('organ') && !already.includes('symphonic')) return true;
  const soloRoles = facts.performers.filter((item) => {
    const role = fieldFolded(item.roleText);
    return (
      hasWord(role, 'piano') ||
      hasWord(role, 'violin') ||
      hasWord(role, 'soprano') ||
      hasWord(role, 'tenor') ||
      hasWord(role, 'mezzosoprano') ||
      hasWord(role, 'mezzo') ||
      hasWord(role, 'baritono') ||
      hasWord(role, 'guitarra')
    );
  });
  const hasOrchestra = already.includes('symphonic') || already.includes('opera');
  if (soloRoles.length > 0 && facts.performers.length <= 3 && !hasOrchestra && !already.includes('choral')) {
    return true;
  }
  return false;
}

function isEarlyMusicFormat(_facts: ObservedFacts, haystack: string): boolean {
  return (
    hasPhrase(haystack, 'universo barroco') ||
    hasPhrase(haystack, 'musica antigua') ||
    hasPhrase(haystack, 'alte musik') ||
    hasPhrase(haystack, 'historicamente informad') ||
    hasPhrase(haystack, 'les arts florissants') ||
    hasPhrase(haystack, 'les musiciens du louvre') ||
    hasPhrase(haystack, 'musica antigua')
  );
}

function isLiedFormat(_facts: ObservedFacts, haystack: string): boolean {
  return hasWord(haystack, 'lied') || hasWord(haystack, 'lieder') || hasWord(haystack, 'melodie');
}

function organEvidence(facts: ObservedFacts): string {
  const organist = facts.performers.find((item) => hasWord(fieldFolded(item.roleText), 'organo'));
  return organist?.roleText ?? facts.title;
}

function choralEvidence(facts: ObservedFacts): string {
  const choir = facts.performers.find(
    (item) => hasWord(fieldFolded(item.roleText), 'coro') || /^coro\b/.test(fieldFolded(item.name)),
  );
  return choir?.name ?? facts.title;
}

function orchestraEvidence(facts: ObservedFacts): string {
  const orchestra = facts.performers.find(
    (item) => hasWord(fieldFolded(item.roleText), 'orquesta') || hasWord(fieldFolded(item.name), 'orquesta'),
  );
  return orchestra?.name ?? facts.title;
}

function chamberEvidence(facts: ObservedFacts): string {
  const ensemble = facts.performers.find(
    (item) =>
      hasWord(fieldFolded(item.roleText), 'cuarteto') ||
      hasWord(fieldFolded(item.roleText), 'ensemble') ||
      hasWord(fieldFolded(item.name), 'cuarteto'),
  );
  return ensemble?.name ?? facts.categoryText ?? facts.title;
}

function recitalEvidence(facts: ObservedFacts): string {
  const solo = facts.performers[0];
  return solo ? `${solo.name}${solo.roleText ? ` (${solo.roleText})` : ''}` : facts.title;
}

function isNamedWorkEvent(facts: ObservedFacts): boolean {
  if (facts.works.length !== 1 || !facts.works[0]) return false;
  return foldName(facts.works[0].title) === foldName(facts.title);
}

function isChamberOrchestraName(haystack: string): boolean {
  return hasPhrase(haystack, 'chamber orchestra') || hasPhrase(haystack, 'orquesta de camara');
}

function uniqueFormats(formats: Format[]): Format[] {
  const set = new Set(formats);
  return FORMAT_ORDER.filter((item) => set.has(item));
}
