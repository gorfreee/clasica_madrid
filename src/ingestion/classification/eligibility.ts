import { matchComposer } from '../knowledge/composers.ts';
import type { ObservedFacts } from '../observed.ts';
import type { Eligibility } from './golden-case.ts';
import { fieldFolded, hasPhrase, hasWord, identityHaystack } from './text.ts';
import type { Resolution } from './types.ts';

type Exclusion = {
  ruleId: string;
  evidence: string[];
  /** The event identity is this activity even if classical names appear. */
  overridesClassical: boolean;
  /** Strong non-classical identity that may share the bill with classical. */
  coprincipal: boolean;
};

type Inclusion = {
  ruleId: string;
  evidence: string[];
};

export function resolveEligibility(facts: ObservedFacts): Resolution<Eligibility> {
  const haystack = identityHaystack(facts);
  const exclusions = collectExclusions(facts, haystack);
  const inclusions = collectInclusions(facts, haystack);
  const overriding = exclusions.filter((item) => item.overridesClassical);
  if (overriding.length > 0) {
    return resolution('exclude', 'rule', overriding[0]!.ruleId, flattenEvidence(overriding));
  }

  const coprincipal = exclusions.filter((item) => item.coprincipal);
  if (coprincipal.length > 0) {
    return resolution(
      'uncertain',
      'rule',
      'classical-and-nonclassical-coprincipal',
      [...flattenEvidence(inclusions), ...flattenEvidence(coprincipal)],
    );
  }

  const hardExclude = exclusions.filter((item) => !item.overridesClassical && !item.coprincipal);
  if (hardExclude.length > 0 && inclusions.length > 0) {
    return resolution(
      'uncertain',
      'rule',
      'classical-and-nonclassical-coprincipal',
      [...flattenEvidence(inclusions), ...flattenEvidence(hardExclude)],
    );
  }
  if (hardExclude.length > 0) {
    return resolution('exclude', 'rule', hardExclude[0]!.ruleId, flattenEvidence(hardExclude));
  }

  if (inclusions.length > 0) {
    return resolution('include', inclusions[0]!.ruleId.startsWith('known-') ? 'knowledge' : 'rule', inclusions[0]!.ruleId, flattenEvidence(inclusions));
  }

  return resolution('uncertain', 'fallback', 'insufficient-evidence', [
    'no hay evidencia musical suficientemente fuerte para include ni una exclusión determinista',
  ]);
}

function collectExclusions(facts: ObservedFacts, haystack: string): Exclusion[] {
  const found: Exclusion[] = [];
  const category = fieldFolded(facts.categoryText);
  const title = fieldFolded(facts.title);
  const description = fieldFolded(facts.description);
  const program = fieldFolded(facts.programText);

  const dj = djIdentity(facts, haystack);
  if (dj) found.push(dj);

  if (hasPhrase(haystack, 'red bull')) {
    found.push(exclusion('crossover-brand', ['red bull'], true));
  }

  const jazz = jazzIdentity(facts, category, title, haystack);
  if (jazz) found.push(jazz);

  const flamenco = flamencoIdentity(facts, category, title, haystack);
  if (flamenco) found.push(flamenco);

  const dance = danceIdentity(facts, category, haystack);
  if (dance) found.push(dance);

  const cinema = cinemaIdentity(facts, category, title, description);
  if (cinema) found.push(cinema);

  const workshop = workshopIdentity(facts, category, title, description);
  if (workshop) found.push(workshop);

  const participatory = participatoryActivity(facts, title, haystack);
  if (participatory) found.push(participatory);

  const film = filmMusicIdentity(facts, haystack);
  if (film) found.push(film);

  const pop = popularMusicIdentity(facts, title, description, program, haystack);
  if (pop) found.push(pop);

  return found;
}

function collectInclusions(facts: ObservedFacts, haystack: string): Inclusion[] {
  const found: Inclusion[] = [];
  const known = knownClassicalNames(facts);
  if (known.length > 0) {
    found.push({
      ruleId: 'known-classical-composer',
      evidence: known,
    });
  }

  const category = fieldFolded(facts.categoryText);
  if (isOperaCategory(category)) {
    found.push({ ruleId: 'opera-event', evidence: [facts.categoryText ?? ''] });
  }
  if (hasWord(category, 'zarzuela') || hasWord(fieldFolded(facts.title), 'zarzuela')) {
    found.push({ ruleId: 'zarzuela-event', evidence: [facts.categoryText ?? facts.title] });
  }
  if (
    hasPhrase(haystack, 'conciertos de organo') ||
    hasPhrase(haystack, 'concierto de organo') ||
    hasPhrase(haystack, 'recital de organo')
  ) {
    found.push({ ruleId: 'organ-concert', evidence: ['conciertos de órgano'] });
  }
  if (describedClassicalPerformance(facts, haystack) && known.length === 0) {
    found.push({
      ruleId: 'described-classical-repertoire',
      evidence: [facts.description ?? facts.programText ?? facts.title],
    });
  }
  if (academicContemporary(facts, haystack) && known.length === 0) {
    found.push({
      ruleId: 'academic-contemporary',
      evidence: [facts.categoryText ?? facts.description ?? facts.title],
    });
  }
  const seriesConcert = classicalConcertSeries(facts, haystack);
  if (seriesConcert) found.push(seriesConcert);
  return found;
}

function djIdentity(facts: ObservedFacts, haystack: string): Exclusion | undefined {
  const hits: string[] = [];
  if (hasWord(fieldFolded(facts.title), 'dj')) hits.push(facts.title);
  for (const performer of facts.performers) {
    if (hasWord(fieldFolded(performer.name), 'dj')) hits.push(performer.name);
  }
  if (hasWord(haystack, 'dj') && hits.length === 0) hits.push('dj');
  if (hits.length === 0) return undefined;
  return exclusion('dj-identity', hits, true);
}

function jazzIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  haystack: string,
): Exclusion | undefined {
  if (hasWord(category, 'jazz') || hasPhrase(category, 'jazz en el auditorio')) {
    return exclusion('jazz-identity', [facts.categoryText ?? ''], true);
  }
  if (hasWord(title, 'jazz')) {
    return exclusion('jazz-identity', [facts.title], true);
  }
  for (const performer of facts.performers) {
    if (hasWord(fieldFolded(performer.name), 'jazz')) {
      return exclusion('jazz-identity', [performer.name], true);
    }
  }
  if (hasWord(haystack, 'jazz') && !knownClassicalNames(facts).length) {
    return exclusion('jazz-identity', ['jazz'], true);
  }
  return undefined;
}

function flamencoIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  haystack: string,
): Exclusion | undefined {
  const titleOrCategory =
    /flamenc/.test(category) ||
    /flamenc/.test(title) ||
    hasPhrase(title, 'paco de lucia') ||
    hasPhrase(category, 'andalucia flamenca');
  const roleOrProgram =
    facts.performers.some(
      (item) =>
        /flamenc/.test(fieldFolded(item.roleText)) ||
        hasWord(fieldFolded(item.roleText), 'cante'),
    ) ||
    /flamenc/.test(haystack) ||
    hasFlamencoPalo(haystack);

  if (titleOrCategory) {
    return exclusion('flamenco-identity', [facts.categoryText ?? facts.title], true);
  }
  if (roleOrProgram) {
    const classicalCue =
      /barroc/.test(haystack) ||
      hasWord(haystack, 'opera') ||
      hasWord(haystack, 'zarzuela') ||
      knownClassicalNames(facts).length > 0;
    return exclusion('flamenco-identity', ['flamenco'], false, classicalCue);
  }
  return undefined;
}

function danceIdentity(facts: ObservedFacts, category: string, haystack: string): Exclusion | undefined {
  if (
    hasWord(category, 'danza') ||
    hasWord(category, 'ballet') ||
    hasPhrase(category, 'danza contemporanea')
  ) {
    return exclusion('dance-spectacle', [facts.categoryText ?? ''], true);
  }
  const company = facts.performers.find((item) => {
    const name = fieldFolded(item.name);
    return (
      hasPhrase(name, 'dance theater') ||
      hasPhrase(name, 'dance project') ||
      hasPhrase(name, 'ballet')
    );
  });
  if (company) {
    return exclusion('dance-spectacle', [company.name], true);
  }
  if (hasPhrase(haystack, 'espectaculo de danza') || hasPhrase(haystack, 'escuela de ballet')) {
    return exclusion('dance-spectacle', ['danza'], true);
  }
  return undefined;
}

function cinemaIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  description: string,
): Exclusion | undefined {
  if (
    hasWord(category, 'proyeccion') ||
    hasPhrase(category, 'cine mudo') ||
    hasWord(category, 'cine') ||
    hasPhrase(title, 'cineclasica') ||
    hasPhrase(title, 'de cine') ||
    hasWord(title, 'cine') ||
    hasPhrase(description, 'proyeccion de') ||
    hasPhrase(description, 'ciclo de cine')
  ) {
    return exclusion('cinema-projection', [facts.categoryText ?? facts.title], true);
  }
  return undefined;
}

function workshopIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  description: string,
): Exclusion | undefined {
  if (
    hasWord(category, 'taller') ||
    hasWord(category, 'conferencia') ||
    hasWord(category, 'coloquio') ||
    hasWord(title, 'taller') ||
    hasWord(title, 'conferencia') ||
    hasPhrase(description, 'un taller') ||
    hasPhrase(description, 'taller de')
  ) {
    return exclusion('non-performance-activity', [facts.categoryText ?? facts.title], true);
  }
  return undefined;
}

function participatoryActivity(
  facts: ObservedFacts,
  title: string,
  haystack: string,
): Exclusion | undefined {
  if (
    hasPhrase(title, 'open piano') ||
    hasPhrase(haystack, 'open piano') ||
    hasPhrase(title, 'piano abierto') ||
    hasPhrase(haystack, 'piano abierto')
  ) {
    return exclusion('participatory-activity', [facts.title], true);
  }
  if (hasPhrase(haystack, 'jam participativa')) {
    return exclusion('participatory-activity', [facts.title], true);
  }
  return undefined;
}

function filmMusicIdentity(facts: ObservedFacts, haystack: string): Exclusion | undefined {
  const evidence: string[] = [];
  if (hasPhrase(haystack, 'film symphony')) evidence.push('film symphony');
  if (hasPhrase(haystack, 'bandas sonoras') || hasPhrase(haystack, 'banda sonora')) {
    evidence.push('banda sonora');
  }
  if (hasPhrase(haystack, 'musica de cine') || hasPhrase(haystack, 'música de cine')) {
    evidence.push('música de cine');
  }
  if (hasPhrase(haystack, 'hans zimmer')) evidence.push('Hans Zimmer');
  if (hasPhrase(haystack, 'john williams')) evidence.push('John Williams');
  if (hasPhrase(haystack, 'ennio morricone')) evidence.push('Ennio Morricone');
  if (hasPhrase(haystack, 'royal film concert')) evidence.push('film concert orchestra');
  if (evidence.length === 0) return undefined;

  const namedFilmIdentity =
    hasPhrase(haystack, 'hans zimmer') ||
    hasPhrase(haystack, 'john williams') ||
    hasPhrase(haystack, 'ennio morricone') ||
    hasPhrase(haystack, 'film symphony') ||
    hasPhrase(haystack, 'royal film concert') ||
    hasPhrase(haystack, 'musica de cine');
  const classicalBlock =
    knownClassicalNames(facts).length > 0 ||
    hasPhrase(haystack, 'musica clasica') ||
    hasPhrase(haystack, 'grandes obras de la musica clasica');
  if (classicalBlock && !namedFilmIdentity) {
    return exclusion('film-music-identity', evidence, false, true);
  }
  return exclusion('film-music-identity', evidence, true);
}

function popularMusicIdentity(
  facts: ObservedFacts,
  title: string,
  description: string,
  program: string,
  haystack: string,
): Exclusion | undefined {
  const evidence: string[] = [];
  if (hasWord(title, 'pop') || hasWord(haystack, 'pop')) evidence.push('pop');
  if (hasPhrase(title, 'grandes del pop')) evidence.push('grandes del pop');
  if (hasWord(title, 'abba') || hasWord(haystack, 'abba')) evidence.push('ABBA');
  if (hasWord(title, 'beatles')) evidence.push('Beatles');
  if (hasWord(title, 'queen') && (hasWord(title, 'pop') || hasWord(title, 'abba') || hasWord(title, 'beatles'))) {
    evidence.push('Queen');
  }
  if (hasPhrase(description, 'melodias populares') || hasPhrase(description, 'villancicos mas famosos')) {
    evidence.push('gala popular');
  }
  if (
    knownClassicalNames(facts).length === 0 &&
    (hasPhrase(description, 'su repertorio') || hasPhrase(description, 'la obra de')) &&
    (hasPhrase(haystack, 'octeto') || hasWord(haystack, 'cuerdas') || hasWord(haystack, 'orquesta'))
  ) {
    evidence.push('repertorio popular con ensemble clásico');
  }
  if (
    knownClassicalNames(facts).length === 0 &&
    popularProgramHit(program)
  ) {
    evidence.push('programa popular');
  }
  if (evidence.length === 0) return undefined;
  return exclusion('popular-music-identity', evidence, true);
}

function popularProgramHit(program: string): boolean {
  return (
    hasWord(program, 'lennon') ||
    hasWord(program, 'sinatra') ||
    hasWord(program, 'feliciano') ||
    hasPhrase(program, 'white christmas') ||
    hasPhrase(program, 'david guetta') ||
    hasPhrase(program, 'daft punk') ||
    hasWord(program, 'avicii') ||
    hasWord(program, 'coldplay')
  );
}

function describedClassicalPerformance(facts: ObservedFacts, _haystack: string): boolean {
  const description = fieldFolded(facts.description);
  if (!description) return false;
  const performs = /interpreta/.test(description);
  const repertoire =
    hasWord(description, 'opera') ||
    hasWord(description, 'zarzuela') ||
    hasPhrase(description, 'temas de zarzuela');
  return performs && repertoire;
}

function academicContemporary(facts: ObservedFacts, haystack: string): boolean {
  const category = fieldFolded(facts.categoryText);
  const contemporary =
    hasPhrase(category, 'musica contemporanea') || hasPhrase(haystack, 'repertorio musical contemporaneo');
  if (!contemporary) return false;
  return (
    hasWord(haystack, 'ensemble') ||
    hasWord(haystack, 'festival') ||
    hasWord(haystack, 'estreno') ||
    hasPhrase(haystack, 'nuevas obras')
  );
}

function classicalConcertSeries(facts: ObservedFacts, haystack: string): Inclusion | undefined {
  const title = fieldFolded(facts.title);
  const description = fieldFolded(facts.description);
  const concertCue =
    hasWord(title, 'concierto') ||
    hasPhrase(haystack, 'serie de conciertos') ||
    (description.length > 0 && hasWord(description, 'conciertos'));
  if (!concertCue) return undefined;

  const seriesCue =
    hasPhrase(haystack, 'domingos de camara') ||
    hasPhrase(haystack, 'liceo de camara') ||
    hasPhrase(haystack, 'musica de camara') ||
    hasPhrase(haystack, 'festival de piano') ||
    hasPhrase(haystack, 'festival internacional de piano') ||
    hasPhrase(haystack, 'ciclo de organo') ||
    hasPhrase(haystack, 'conciertos de organo') ||
    hasPhrase(haystack, 'ciclo de grandes autores');
  if (!seriesCue) return undefined;

  return {
    ruleId: 'classical-concert-series',
    evidence: [facts.seriesText ?? facts.categoryText ?? facts.title],
  };
}

function isOperaCategory(category: string): boolean {
  return hasWord(category, 'opera') && !hasWord(category, 'taller');
}

function knownClassicalNames(facts: ObservedFacts): string[] {
  const names = [
    ...facts.composers.map((item) => item.name),
    ...facts.works.flatMap((item) => (item.composerName ? [item.composerName] : [])),
  ];
  const matched: string[] = [];
  for (const name of names) {
    const hit = matchComposer(name);
    if (hit) matched.push(hit.canonicalName);
  }
  return [...new Set(matched)];
}

function hasFlamencoPalo(haystack: string): boolean {
  return (
    hasWord(haystack, 'bulerias') ||
    hasWord(haystack, 'rondeña') ||
    hasWord(haystack, 'rondena') ||
    hasWord(haystack, 'farruca') ||
    hasWord(haystack, 'seguiriyas') ||
    hasWord(haystack, 'seguiriya') ||
    hasWord(haystack, 'minera') ||
    hasWord(haystack, 'solea') ||
    hasWord(haystack, 'taranta')
  );
}

function exclusion(
  ruleId: string,
  evidence: string[],
  overridesClassical: boolean,
  coprincipal = false,
): Exclusion {
  return { ruleId, evidence: evidence.filter(Boolean), overridesClassical, coprincipal };
}

function flattenEvidence(items: Array<{ evidence: string[] }>): string[] {
  return [...new Set(items.flatMap((item) => item.evidence).filter(Boolean))];
}

function resolution(
  value: Eligibility,
  method: Resolution<Eligibility>['method'],
  ruleId: string,
  evidence: string[],
): Resolution<Eligibility> {
  return { value, method, ruleId, evidence };
}
