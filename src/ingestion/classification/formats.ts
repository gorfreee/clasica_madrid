import type { Format } from '../../lib/schemas/taxonomies.ts';
import type { ObservedFacts, ObservedPerson } from '../observed.ts';
import {
  evidenceHasPhrase,
  evidenceHasWord,
  fieldFolded,
  foldName,
  formatEvidence,
  hasPhrase,
  hasWord,
  type FormatEvidence,
} from './text.ts';
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
  const evidence = formatEvidence(facts);
  const hits: Array<{ format: Format; ruleId: string; evidence: string }> = [];

  if (isOperaFormat(facts, evidence)) {
    hits.push({ format: 'opera', ruleId: 'opera-format', evidence: facts.categoryText ?? facts.title });
  }
  if (isZarzuelaFormat(facts, evidence)) {
    hits.push({ format: 'zarzuela', ruleId: 'zarzuela-format', evidence: facts.title });
  }
  if (isOrganFormat(facts, evidence)) {
    hits.push({ format: 'organ', ruleId: 'organ-format', evidence: organEvidence(facts) });
  }
  if (isChoralFormat(facts, evidence)) {
    hits.push({ format: 'choral', ruleId: 'choral-format', evidence: choralEvidence(facts) });
  }
  if (isSymphonicFormat(facts, evidence)) {
    hits.push({ format: 'symphonic', ruleId: 'symphonic-format', evidence: orchestraEvidence(facts) });
  }
  if (isChamberFormat(facts, evidence)) {
    hits.push({ format: 'chamber', ruleId: 'chamber-format', evidence: chamberEvidence(facts) });
  }
  if (isRecitalFormat(facts, evidence, hits.map((item) => item.format))) {
    hits.push({ format: 'recital', ruleId: 'recital-format', evidence: recitalEvidence(facts) });
  }
  if (isEarlyMusicFormat(evidence)) {
    hits.push({
      format: 'early-music',
      ruleId: 'early-music-format',
      evidence: facts.categoryText ?? facts.title,
    });
  }
  if (isLiedFormat(evidence)) {
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

function isOperaFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  const category = fieldFolded(facts.categoryText);
  const title = fieldFolded(facts.title);
  if (hasWord(category, 'taller')) return false;
  // Same title/category signals as eligibility `opera-event` / `isOperaTitle`.
  if (hasWord(category, 'opera') || hasWord(title, 'opera') || /\bmicroperas?\b/u.test(title)) {
    return true;
  }
  const genreFields = genreFieldsOf(evidence);
  return (
    evidenceHasPhrase(genreFields, 'arias de opera') ||
    evidenceHasPhrase(genreFields, 'dramma lirico') ||
    evidenceHasPhrase(genreFields, 'opera en') ||
    (evidenceHasWord(genreFields, 'opera') && evidenceHasWord(genreFields, 'actos'))
  );
}

function isZarzuelaFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  const category = fieldFolded(facts.categoryText);
  const title = fieldFolded(facts.title);
  if (hasWord(category, 'zarzuela') || hasWord(title, 'zarzuela')) return true;
  const genreFields = genreFieldsOf(evidence);
  return evidenceHasPhrase(genreFields, 'de zarzuelas') || evidenceHasPhrase(genreFields, 'zarzuela de');
}

function isOrganFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  const eventFields = eventFieldsOf(evidence);
  if (
    evidenceHasPhrase(eventFields, 'conciertos de organo') ||
    evidenceHasPhrase(eventFields, 'concierto de organo') ||
    evidenceHasPhrase(eventFields, 'recital de organo') ||
    evidenceHasPhrase(eventFields, 'ciclo internacional de organo')
  ) {
    return true;
  }
  if (
    evidenceHasWord(eventFields, 'organo') &&
    (evidenceHasWord(eventFields, 'concierto') ||
      evidenceHasWord(eventFields, 'recital') ||
      evidenceHasWord(eventFields, 'ciclo'))
  ) {
    return true;
  }
  return facts.performers.some((item) => {
    const role = fieldFolded(item.roleText);
    return hasWord(role, 'organo') || hasWord(role, 'organista');
  });
}

function isChoralFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  if (evidenceHasWord(genreFieldsOf(evidence), 'oratorio')) return true;
  if (isNamedWorkEvent(facts)) return false;
  const title = fieldFolded(facts.title);
  const category = fieldFolded(facts.categoryText);
  if (
    hasWord(title, 'coro') ||
    hasWord(title, 'choir') ||
    hasWord(category, 'coro') ||
    hasWord(category, 'coral') ||
    hasWord(category, 'choir')
  ) {
    return true;
  }
  if (facts.performers.some((item) => hasWord(fieldFolded(item.roleText), 'coro'))) return true;
  return facts.performers.some((item) => {
    const name = fieldFolded(item.name);
    return (
      hasWord(name, 'coro') ||
      hasWord(name, 'choir') ||
      hasWord(name, 'cantores') ||
      hasPhrase(name, 'schola cantorum')
    );
  });
}

function isSymphonicFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  if (isNamedWorkEvent(facts)) return false;
  const category = fieldFolded(facts.categoryText);
  if (hasWord(category, 'sinfonica') || hasWord(category, 'sinfonico')) return true;
  if (hasSymphonicEventWord(evidence.identity)) return true;
  if (
    evidenceHasPhrase([evidence.identity, ...evidence.performers], 'orquesta y coro') ||
    evidenceHasPhrase([evidence.identity, ...evidence.performers], 'orquestra y coro')
  ) {
    return true;
  }
  if (hasOrchestraFormation(evidence.identity)) return true;
  return facts.performers.some((item) => isOrchestraPerformer(item));
}

function isChamberFormat(facts: ObservedFacts, evidence: FormatEvidence): boolean {
  const category = fieldFolded(facts.categoryText);
  if (isMusicalChamberCategory(category, evidence.identity)) return true;
  if (hasChamberFormation(evidence.identity)) return true;
  if (evidence.performers.some((text) => hasChamberFormation(text))) return true;
  if (facts.performers.some((item) => hasWord(fieldFolded(item.roleText), 'cuarteto'))) return true;
  return facts.performers.some((item) => hasPhrase(fieldFolded(item.name), 'chamber orchestra'));
}

function isRecitalFormat(facts: ObservedFacts, evidence: FormatEvidence, already: Format[]): boolean {
  if (evidenceHasWord([evidence.identity, evidence.program], 'recital')) return true;
  if (already.includes('organ') && !already.includes('symphonic')) return true;
  const soloRoles = facts.performers.filter((item) => {
    const role = fieldFolded(item.roleText);
    return (
      hasWord(role, 'piano') ||
      hasWord(role, 'pianista') ||
      hasWord(role, 'violin') ||
      hasWord(role, 'violinista') ||
      hasWord(role, 'viola') ||
      hasWord(role, 'violonchelo') ||
      hasWord(role, 'violoncello') ||
      hasWord(role, 'cello') ||
      hasWord(role, 'clave') ||
      hasWord(role, 'clavecin') ||
      hasWord(role, 'clavecinista') ||
      hasWord(role, 'harpsichord') ||
      hasWord(role, 'flauta') ||
      hasWord(role, 'flute') ||
      hasWord(role, 'oboe') ||
      hasWord(role, 'clarinet') ||
      hasWord(role, 'clarinete') ||
      hasWord(role, 'arpa') ||
      hasWord(role, 'harp') ||
      hasWord(role, 'organista') ||
      hasWord(role, 'soprano') ||
      hasWord(role, 'tenor') ||
      hasWord(role, 'contralto') ||
      hasWord(role, 'contratenor') ||
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

function isEarlyMusicFormat(evidence: FormatEvidence): boolean {
  const eventFields = eventFieldsOf(evidence);
  return (
    evidenceHasPhrase(eventFields, 'universo barroco') ||
    evidenceHasPhrase(eventFields, 'musica antigua') ||
    evidenceHasPhrase(eventFields, 'alte musik') ||
    evidenceHasPhrase(eventFields, 'historicamente informad') ||
    evidenceHasPhrase(eventFields, 'les arts florissants') ||
    evidenceHasPhrase(eventFields, 'les musiciens du louvre')
  );
}

function isLiedFormat(evidence: FormatEvidence): boolean {
  const eventFields = [evidence.identity, evidence.program];
  return (
    evidenceHasWord(eventFields, 'lied') ||
    evidenceHasWord(eventFields, 'lieder') ||
    evidenceHasWord(eventFields, 'melodie')
  );
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
  const orchestra = facts.performers.find((item) => isOrchestraPerformer(item));
  return orchestra?.name ?? facts.title;
}

function chamberEvidence(facts: ObservedFacts): string {
  const ensemble = facts.performers.find(
    (item) =>
      hasWord(fieldFolded(item.roleText), 'cuarteto') ||
      hasWord(fieldFolded(item.roleText), 'ensemble') ||
      hasChamberFormation(fieldFolded(item.name)),
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

function isOrchestraPerformer(item: ObservedPerson): boolean {
  const role = fieldFolded(item.roleText);
  const name = fieldFolded(item.name);
  if (isOrchestraMembersLabel(name) || isOrchestraMembersLabel(role)) return false;
  if (isChamberOrchestraName(name) && !hasSymphonicEventWord(name)) return false;
  if (isOrchestraRole(role)) return true;
  return hasOrchestraFormation(name);
}

/** Role names the performing body as an orchestra, not a conductor of one. */
function isOrchestraRole(role: string): boolean {
  if (!role) return false;
  if (hasWord(role, 'director') || hasWord(role, 'direccion') || hasWord(role, 'concertino')) {
    return false;
  }
  return hasWord(role, 'orquesta') || hasWord(role, 'orquestra') || hasWord(role, 'orchestra');
}

function hasOrchestraFormation(text: string): boolean {
  if (!text) return false;
  if (isOrchestraMembersLabel(text)) return false;
  if (isChamberOrchestraName(text) && !hasSymphonicEventWord(text)) return false;
  return hasWord(text, 'orquesta') || hasWord(text, 'orquestra') || hasWord(text, 'orchestra');
}

function isOrchestraMembersLabel(text: string): boolean {
  return /(?:solistas|miembros|musicos|concertino) de (?:la |el |the )?(?:orquesta|orquestra|orchestra)/.test(
    text,
  );
}

function isChamberOrchestraName(text: string): boolean {
  return (
    hasPhrase(text, 'chamber orchestra') ||
    hasPhrase(text, 'orquesta de camara') ||
    hasPhrase(text, 'orquestra de cambra')
  );
}

function hasSymphonicEventWord(text: string): boolean {
  return (
    hasWord(text, 'sinfonico') ||
    hasWord(text, 'sinfonica') ||
    hasWord(text, 'symphonic') ||
    hasWord(text, 'symphony')
  );
}

function hasChamberFormation(text: string): boolean {
  if (!text) return false;
  return (
    hasWord(text, 'cuarteto') ||
    hasWord(text, 'quinteto') ||
    hasWord(text, 'sexteto') ||
    hasWord(text, 'octeto') ||
    hasWord(text, 'trio') ||
    hasWord(text, 'duo') ||
    hasPhrase(text, 'liceo de camara') ||
    hasPhrase(text, 'domingos de camara') ||
    hasPhrase(text, 'musica de camara') ||
    hasPhrase(text, 'festival de ensembles') ||
    isChamberOrchestraName(text)
  );
}

/** Municipal / source category `camara` when the event is already musical. */
function isMusicalChamberCategory(category: string, identity: string): boolean {
  if (!hasWord(category, 'camara')) return false;
  if (hasPhrase(category, 'camara de comercio') || hasPhrase(category, 'camara de fotos')) return false;
  if (category === 'camara' || hasPhrase(category, 'musica de camara')) return true;
  return (
    hasWord(identity, 'concierto') ||
    hasWord(identity, 'musica') ||
    hasWord(identity, 'recital') ||
    hasWord(identity, 'cuarteto') ||
    hasWord(identity, 'duo') ||
    hasWord(identity, 'trio')
  );
}

function eventFieldsOf(evidence: FormatEvidence): string[] {
  return [evidence.identity, ...evidence.performers, evidence.program];
}

function genreFieldsOf(evidence: FormatEvidence): string[] {
  return [...eventFieldsOf(evidence), evidence.narrative];
}

function uniqueFormats(formats: Format[]): Format[] {
  const set = new Set(formats);
  return FORMAT_ORDER.filter((item) => set.has(item));
}
