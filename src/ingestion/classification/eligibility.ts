import { findKnownComposersInText, matchComposer } from '../knowledge/composers.ts';
import type { ObservedFacts } from '../observed.ts';
import type { Eligibility } from './golden-case.ts';
import { fieldFolded, foldName, hasPhrase, hasWord, identityHaystack } from './text.ts';
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
    if (inclusions.length > 0 && hasSubstantialClassicalBlock(facts)) {
      return resolution(
        'include',
        inclusions[0]!.ruleId.startsWith('known-') ? 'knowledge' : 'rule',
        'mixed-program-classical-block',
        [...flattenEvidence(inclusions), ...flattenEvidence(coprincipal)],
      );
    }
    return resolution(
      'uncertain',
      'rule',
      'classical-and-nonclassical-coprincipal',
      [...flattenEvidence(inclusions), ...flattenEvidence(coprincipal)],
    );
  }

  const hardExclude = exclusions.filter((item) => !item.overridesClassical && !item.coprincipal);
  if (hardExclude.length > 0 && inclusions.length > 0) {
    if (hasSubstantialClassicalBlock(facts)) {
      return resolution(
        'include',
        inclusions[0]!.ruleId.startsWith('known-') ? 'knowledge' : 'rule',
        'mixed-program-classical-block',
        [...flattenEvidence(inclusions), ...flattenEvidence(hardExclude)],
      );
    }
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

  const dance = danceIdentity(facts, category, title);
  if (dance) found.push(dance);

  const cinema = cinemaIdentity(facts, category, title, description, haystack);
  if (cinema) found.push(cinema);

  const workshop = workshopIdentity(facts, category, title, description, program);
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
  const title = fieldFolded(facts.title);
  if (isOperaCategory(category) || isOperaTitle(title)) {
    found.push({ ruleId: 'opera-event', evidence: [facts.categoryText ?? facts.title] });
  }
  if (hasWord(category, 'lirica') && !hasWord(category, 'taller')) {
    found.push({ ruleId: 'lyric-theatre-event', evidence: [facts.categoryText ?? ''] });
  }
  if (hasWord(category, 'zarzuela') || hasWord(title, 'zarzuela')) {
    found.push({ ruleId: 'zarzuela-event', evidence: [facts.categoryText ?? facts.title] });
  }
  if (organConcertInclusion(facts, haystack)) {
    found.push({ ruleId: 'organ-concert', evidence: ['concierto o recital de órgano'] });
  }
  const explicitClassical = explicitClassicalConcertDeclaration(facts);
  if (explicitClassical) found.push(explicitClassical);
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
  const series = fieldFolded(facts.seriesText);
  if (
    hasWord(category, 'jazz') ||
    hasPhrase(category, 'jazz en el auditorio') ||
    hasWord(series, 'jazz') ||
    hasPhrase(series, 'jazz en el auditorio')
  ) {
    return exclusion('jazz-identity', [facts.categoryText ?? facts.seriesText ?? ''], true);
  }
  if (hasWord(title, 'jazz')) {
    return exclusion('jazz-identity', [facts.title], true);
  }
  for (const performer of facts.performers) {
    if (hasWord(fieldFolded(performer.name), 'jazz')) {
      return exclusion('jazz-identity', [performer.name], true);
    }
  }
  if (hasPhrase(haystack, 'miles davis')) {
    return exclusion('jazz-identity', ['Miles Davis'], true);
  }

  const body = `${fieldFolded(facts.description)} ${fieldFolded(facts.programText)}`.trim();
  if (explicitJazzConcertIdentity(body)) {
    return exclusion('jazz-identity', ['jazz'], true);
  }
  if (hasWord(body, 'jazz')) {
    return exclusion('jazz-identity', ['jazz'], false, true);
  }
  return undefined;
}

function explicitJazzConcertIdentity(body: string): boolean {
  return (
    hasPhrase(body, 'concierto de jazz') ||
    hasPhrase(body, 'ciclo de jazz') ||
    hasPhrase(body, 'recital de jazz') ||
    hasPhrase(body, 'jazz en el auditorio')
  );
}

function flamencoIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  haystack: string,
): Exclusion | undefined {
  if (!hasMusicalFlamencoIdentity(facts, haystack)) return undefined;

  const titleOrCategory =
    /flamenc/.test(category) ||
    /flamenc/.test(title) ||
    hasPhrase(title, 'paco de lucia') ||
    hasPhrase(category, 'andalucia flamenca') ||
    hasPhrase(title, 'zambomba') ||
    hasPhrase(category, 'zambomba');
  if (titleOrCategory) {
    return exclusion('flamenco-identity', [facts.categoryText ?? facts.title], true);
  }
  const classicalCue =
    /barroc/.test(haystack) ||
    hasWord(haystack, 'opera') ||
    hasWord(haystack, 'zarzuela') ||
    knownClassicalNames(facts).length > 0;
  return exclusion('flamenco-identity', ['flamenco'], false, classicalCue);
}

/**
 * Musical flamenco (cante, palos, Paco de Lucía, zambomba, etc.), not Flemish /
 * franco-flemish Renaissance vocabulary such as "compositores flamencos del
 * Códice de Chigi".
 */
function hasMusicalFlamencoIdentity(facts: ObservedFacts, haystack: string): boolean {
  if (hasPhrase(haystack, 'paco de lucia')) return true;
  if (hasPhrase(haystack, 'zambomba')) return true;
  if (hasPhrase(haystack, 'jovenes flamencos') || hasPhrase(haystack, 'joven flamenco')) return true;
  if (hasPhrase(haystack, 'guitarra flamenca')) return true;
  if (hasPhrase(haystack, 'cante flamenco') || hasPhrase(haystack, 'baile flamenco')) return true;
  if (hasPhrase(haystack, 'recital de flamenco') || hasPhrase(haystack, 'concierto de flamenco')) {
    return true;
  }
  if (hasPhrase(haystack, 'gala de flamenco') || hasPhrase(haystack, 'gala flamenca')) return true;
  if (hasPhrase(haystack, 'espectaculo de flamenco') || hasPhrase(haystack, 'noche flamenca')) {
    return true;
  }
  if (hasFlamencoPalo(haystack)) return true;
  if (
    facts.performers.some(
      (item) =>
        /flamenc/.test(fieldFolded(item.roleText)) || hasWord(fieldFolded(item.roleText), 'cante'),
    )
  ) {
    return true;
  }

  if (!/flamenc/.test(haystack)) return false;
  return flamencoTokenRemainsAfterFlemishGuards(haystack);
}

const FLEMISH_SCHOOL_PATTERNS: RegExp[] = [
  /franco[\s-]*flamenc\w*/,
  /escuela flamenc\w*/,
  /polifonia flamenc\w*/,
  /compositores? flamenc\w* renacent\w*/,
  /flamenc\w* renacent\w*/,
  /flamenc\w* del codice\w*/,
  /flamenc\w* del renacim\w*/,
  /codice de chigi/,
  /chigi codex/,
];

function flamencoTokenRemainsAfterFlemishGuards(haystack: string): boolean {
  let stripped = haystack;
  for (const pattern of FLEMISH_SCHOOL_PATTERNS) {
    stripped = stripped.replace(new RegExp(pattern.source, 'g'), ' ');
  }
  return /flamenc/.test(stripped);
}

function danceIdentity(facts: ObservedFacts, category: string, title: string): Exclusion | undefined {
  const principalEvidence: string[] = [];
  if (
    hasWord(category, 'danza') ||
    hasWord(category, 'ballet') ||
    hasPhrase(category, 'danza contemporanea')
  ) {
    principalEvidence.push(facts.categoryText ?? '');
  }
  if (titleIdentifiesDanceOrBallet(title)) {
    principalEvidence.push(facts.title);
  }
  const spectacleFields = `${title} ${category} ${fieldFolded(facts.description)}`;
  if (hasPhrase(spectacleFields, 'espectaculo de danza')) {
    principalEvidence.push('espectáculo de danza');
  }
  if (hasPhrase(spectacleFields, 'escuela de ballet')) {
    principalEvidence.push('escuela de ballet');
  }

  const company = facts.performers.find(
    (item) => isDanceCompanyName(item.name) || isDanceRole(item.roleText),
  );
  const secondaryEvidence = company ? [company.name || company.roleText || 'danza'] : [];

  if (principalEvidence.length === 0 && secondaryEvidence.length === 0) return undefined;
  if (principalEvidence.length > 0) {
    return exclusion('dance-spectacle', principalEvidence, true);
  }
  if (hasIndependentLiveMusicalPerformance(facts)) {
    return exclusion('dance-spectacle', secondaryEvidence, false, true);
  }
  return exclusion('dance-spectacle', secondaryEvidence, true);
}

function titleIdentifiesDanceOrBallet(title: string): boolean {
  if (hasWord(title, 'ballet')) return true;
  if (hasPhrase(title, 'gala de danza') || hasPhrase(title, 'espectaculo de danza')) return true;
  if (hasPhrase(title, 'compania de danza') || hasPhrase(title, 'danza contemporanea')) return true;
  return hasWord(title, 'danza') && (hasWord(title, 'gala') || hasWord(title, 'espectaculo'));
}

/**
 * A dance company is coprincipal only when the bill also has a live musical
 * performance of its own: orchestra/ensemble/musicians, or an unequivocal
 * concert/recital declaration. Named classical composers are not enough — a
 * ballet routinely plays Tchaikovsky and remains a dance spectacle.
 */
function hasIndependentLiveMusicalPerformance(facts: ObservedFacts): boolean {
  const title = fieldFolded(facts.title);
  const category = fieldFolded(facts.categoryText);
  const series = fieldFolded(facts.seriesText);
  if (
    hasWord(title, 'concierto') ||
    hasWord(title, 'recital') ||
    hasWord(category, 'concierto') ||
    hasWord(category, 'recital') ||
    hasWord(series, 'concierto') ||
    hasWord(series, 'recital')
  ) {
    return true;
  }
  if (classicalSeriesIdentity(facts)) return true;
  return facts.performers.some((item) => isLiveMusicalPerformer(item));
}

function isLiveMusicalPerformer(item: { name: string; roleText?: string }): boolean {
  if (isDanceCompanyName(item.name) || isDanceRole(item.roleText)) return false;
  const name = fieldFolded(item.name);
  const role = fieldFolded(item.roleText);
  return (
    hasWord(name, 'orquesta') ||
    hasWord(name, 'orchestra') ||
    hasWord(name, 'orquestra') ||
    hasWord(name, 'ensemble') ||
    hasWord(name, 'filarmonia') ||
    hasWord(name, 'filarmonica') ||
    hasWord(name, 'philharmonic') ||
    hasWord(name, 'coro') ||
    hasWord(role, 'orquesta') ||
    hasWord(role, 'orchestra') ||
    hasWord(role, 'orquestra') ||
    hasWord(role, 'ensemble') ||
    hasWord(role, 'coro') ||
    hasWord(role, 'choir') ||
    hasWord(role, 'piano') ||
    hasWord(role, 'violin') ||
    hasWord(role, 'viola') ||
    hasWord(role, 'cello') ||
    hasWord(role, 'chelo') ||
    hasWord(role, 'organo') ||
    hasWord(role, 'organista') ||
    hasWord(role, 'soprano') ||
    hasWord(role, 'tenor') ||
    hasWord(role, 'baritono') ||
    hasWord(role, 'mezzosoprano') ||
    hasWord(role, 'contralto') ||
    hasWord(role, 'flauta')
  );
}

function isDanceCompanyName(name: string): boolean {
  const folded = fieldFolded(name);
  return (
    hasPhrase(folded, 'dance theater') ||
    hasPhrase(folded, 'dance project') ||
    hasWord(folded, 'ballet') ||
    hasPhrase(folded, 'compania de danza') ||
    hasWord(folded, 'danza') ||
    hasPhrase(folded, 'coreografia')
  );
}

function isDanceRole(roleText: string | undefined): boolean {
  const role = fieldFolded(roleText);
  return (
    hasWord(role, 'coreografo') ||
    hasWord(role, 'coreografia') ||
    hasWord(role, 'bailarin') ||
    hasWord(role, 'bailarina') ||
    hasWord(role, 'danza') ||
    hasWord(role, 'ballet')
  );
}

function cinemaIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  description: string,
  haystack: string,
): Exclusion | undefined {
  if (
    !(
      hasWord(category, 'proyeccion') ||
      hasPhrase(category, 'cine mudo') ||
      hasWord(category, 'cine') ||
      hasPhrase(title, 'cineclasica') ||
      hasPhrase(title, 'de cine') ||
      hasWord(title, 'cine') ||
      hasWord(title, 'proyeccion') ||
      hasPhrase(title, 'pelicula muda') ||
      hasPhrase(description, 'proyeccion de') ||
      hasPhrase(description, 'ciclo de cine') ||
      hasPhrase(description, 'pelicula muda') ||
      hasPhrase(description, 'cine mudo')
    )
  ) {
    return undefined;
  }
  const evidence = [facts.categoryText ?? facts.title];
  if (hasConcertIdentityBesidesOrganRole(facts, haystack)) {
    return exclusion('cinema-projection', evidence, false, true);
  }
  return exclusion('cinema-projection', evidence, true);
}

/**
 * Cinema becomes coprincipal only with positive concert identity besides an
 * organist in the cast: concert/recital/musical cycle, a named classical
 * series, or improvisation presented as the performance. Organ accompaniment
 * of a film screening stays a projection.
 */
function hasConcertIdentityBesidesOrganRole(facts: ObservedFacts, haystack: string): boolean {
  if (
    hasPhrase(haystack, 'concierto de organo') ||
    hasPhrase(haystack, 'conciertos de organo') ||
    hasPhrase(haystack, 'recital de organo') ||
    hasPhrase(haystack, 'concierto en el organo') ||
    hasPhrase(haystack, 'ciclo de organo') ||
    hasPhrase(haystack, 'ciclo internacional de organo')
  ) {
    return true;
  }

  const title = fieldFolded(facts.title);
  const category = fieldFolded(facts.categoryText);
  const series = fieldFolded(facts.seriesText);
  if (
    hasWord(title, 'concierto') ||
    hasWord(title, 'recital') ||
    hasWord(category, 'concierto') ||
    hasWord(category, 'recital') ||
    hasWord(series, 'concierto') ||
    hasWord(series, 'recital')
  ) {
    return true;
  }
  if (hasWord(title, 'ciclo') && hasWord(title, 'organo')) return true;
  if (classicalSeriesIdentity(facts)) return true;

  return (
    hasPhrase(haystack, 'improvisacion') &&
    (hasPhrase(haystack, 'improvisaciones sobre') ||
      hasPhrase(haystack, 'improvisacion concebida') ||
      hasWord(title, 'improvisacion') ||
      hasPhrase(haystack, 'concierto') ||
      hasPhrase(haystack, 'recital'))
  );
}

const NON_PERFORMANCE_LABELS = ['taller', 'conferencia', 'coloquio', 'charla'] as const;

function workshopIdentity(
  facts: ObservedFacts,
  category: string,
  title: string,
  description: string,
  program: string,
): Exclusion | undefined {
  const evidence = facts.categoryText ?? facts.title;
  if (nonPerformanceCategory(category)) {
    return exclusion('non-performance-activity', [evidence], true);
  }

  const titleIsActivity = titleIdentifiesNonPerformance(title);
  const concertIdentity = hasConcertOrRecitalIdentity(facts, title, category);
  const bodyIsActivity = bodyIdentifiesNonPerformance(description, program);
  const weakMention = weakNonPerformanceMention(title, description, program);
  const leadingPerformance = titleStartsWithConcertOrRecital(title);

  // A title that names the event as a talk/workshop stays exclude even when it
  // mentions a concert as the subject ("Charla sobre el concierto de…").
  // A leading recital/concert with a later talk clause is secondary, not identity.
  if (titleIsActivity && !leadingPerformance) {
    return exclusion('non-performance-activity', [facts.title], true);
  }

  if (bodyIsActivity && !concertIdentity) {
    return exclusion('non-performance-activity', [evidence], true);
  }

  // A real concert/recital that also mentions a talk or workshop keeps the
  // performance as the identity. Do not strong-exclude on a secondary mention.
  if (concertIdentity || leadingPerformance) return undefined;

  if (titleIsActivity || bodyIsActivity || weakMention) {
    if (knownClassicalNames(facts).length > 0) {
      return exclusion('non-performance-activity', [evidence], false, true);
    }
    if (titleIsActivity || bodyIsActivity) {
      return exclusion('non-performance-activity', [evidence], true);
    }
  }
  return undefined;
}

function nonPerformanceCategory(category: string): boolean {
  return NON_PERFORMANCE_LABELS.some((label) => hasWord(category, label));
}

function titleStartsWithNonPerformance(title: string): boolean {
  if (/^(charla|conferencia|coloquio)\b/.test(title)) return true;
  return /^taller\s+(de|musical|en)\b/.test(title);
}

function titleStartsWithConcertOrRecital(title: string): boolean {
  return /^(concierto|recital)\b/.test(title);
}

function titleIdentifiesNonPerformance(title: string): boolean {
  if (titleStartsWithNonPerformance(title)) return true;
  // After a separator, charla/conferencia/coloquio name the activity.
  // Bare "Taller" is not enough: "Festival: TALLER SONORO" is an ensemble.
  if (/[:·|]\s*(charla|conferencia|coloquio)\b/.test(title)) return true;
  if (hasPhrase(title, 'taller de') || hasPhrase(title, 'un taller') || hasPhrase(title, 'taller musical')) {
    return true;
  }
  if (hasPhrase(title, 'conferencia sobre') || hasPhrase(title, 'coloquio sobre')) return true;
  if (hasPhrase(title, 'charla sobre') && !/\bcon charla\b/.test(title)) return true;
  return false;
}

function bodyIdentifiesNonPerformance(description: string, program: string): boolean {
  const body = `${description} ${program}`.trim();
  return (
    hasPhrase(body, 'un taller') ||
    hasPhrase(body, 'taller de') ||
    hasPhrase(body, 'taller musical')
  );
}

function weakNonPerformanceMention(title: string, description: string, program: string): boolean {
  const haystack = `${title} ${description} ${program}`.trim();
  return NON_PERFORMANCE_LABELS.some((label) => hasWord(haystack, label));
}

function hasConcertOrRecitalIdentity(
  facts: ObservedFacts,
  title: string,
  category: string,
): boolean {
  const series = fieldFolded(facts.seriesText);
  return (
    hasWord(title, 'concierto') ||
    hasWord(title, 'recital') ||
    hasWord(category, 'concierto') ||
    hasWord(category, 'recital') ||
    hasWord(series, 'concierto') ||
    hasWord(series, 'recital')
  );
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
  const strong: string[] = [];
  if (hasWord(title, 'pop')) strong.push('pop');
  if (hasPhrase(title, 'grandes del pop')) strong.push('grandes del pop');
  if (hasPhrase(title, 'musicales en concierto') || hasPhrase(haystack, 'broadway')) {
    strong.push('Broadway / musical');
  }
  if (hasWord(title, 'abba') || hasWord(haystack, 'abba')) strong.push('ABBA');
  if (hasWord(title, 'beatles')) strong.push('Beatles');
  if (hasWord(title, 'queen') && (hasWord(title, 'pop') || hasWord(title, 'abba') || hasWord(title, 'beatles'))) {
    strong.push('Queen');
  }
  if (hasPhrase(description, 'melodias populares') || hasPhrase(description, 'villancicos mas famosos')) {
    strong.push('gala popular');
  }

  const adjacent: string[] = [];
  if (hasWord(haystack, 'pop') && !hasWord(title, 'pop')) adjacent.push('pop');
  if (popularProgramHit(program) || popularProgramHit(haystack)) {
    adjacent.push('programa popular');
  }

  if (strong.length > 0) {
    return exclusion('popular-music-identity', [...new Set(strong)], true);
  }
  if (adjacent.length === 0) return undefined;
  const classical = knownClassicalNames(facts).length > 0;
  return exclusion('popular-music-identity', [...new Set(adjacent)], !classical, classical);
}

function popularProgramHit(text: string): boolean {
  return (
    hasWord(text, 'lennon') ||
    hasWord(text, 'sinatra') ||
    hasWord(text, 'feliciano') ||
    hasPhrase(text, 'white christmas') ||
    hasPhrase(text, 'david guetta') ||
    hasPhrase(text, 'daft punk') ||
    hasWord(text, 'avicii') ||
    hasWord(text, 'coldplay') ||
    hasPhrase(text, 'tom petty') ||
    hasPhrase(text, 'bill withers')
  );
}

/**
 * Mixed programmes are include only when classical is a listed block, not one
 * named composer inside an otherwise popular bill.
 */
function hasSubstantialClassicalBlock(facts: ObservedFacts): boolean {
  const known = knownClassicalNames(facts);
  if (known.length >= 2) return true;
  if (liveOrganPerformance(facts, identityHaystack(facts))) return true;
  if (known.length === 0) return false;
  if (classicalFirstHalf(facts, known)) return true;
  return explicitListedClassicalWork(facts, known);
}

const CLASSICAL_WORK_NOUNS = [
  'sonata',
  'sonatas',
  'sinfonia',
  'sinfonias',
  'concierto',
  'conciertos',
  'suite',
  'suites',
  'misa',
  'requiem',
  'toccata',
  'fuga',
  'cuarteto',
  'quinteto',
  'oratorio',
  'cantata',
  'obertura',
  'preludio',
  'nocturno',
  'partita',
];

function explicitListedClassicalWork(facts: ObservedFacts, known: string[]): boolean {
  const program = fieldFolded(facts.programText);
  if (!program) return false;
  if (!known.some((name) => hasPhrase(program, name))) return false;
  return CLASSICAL_WORK_NOUNS.some((noun) => hasWord(program, noun));
}

function organConcertInclusion(facts: ObservedFacts, haystack: string): boolean {
  if (
    hasPhrase(haystack, 'conciertos de organo') ||
    hasPhrase(haystack, 'concierto de organo') ||
    hasPhrase(haystack, 'recital de organo') ||
    hasPhrase(haystack, 'concierto en el organo')
  ) {
    return true;
  }
  return facts.performers.some((item) => {
    const role = fieldFolded(item.roleText);
    const name = fieldFolded(item.name);
    return hasWord(role, 'organo') || hasWord(role, 'organista') || hasWord(name, 'organista');
  });
}

function liveOrganPerformance(facts: ObservedFacts, haystack: string): boolean {
  if (organConcertInclusion(facts, haystack)) return true;
  if (
    hasPhrase(haystack, 'ciclo de organo') ||
    hasPhrase(haystack, 'ciclo internacional de organo')
  ) {
    return true;
  }
  return (
    hasWord(haystack, 'organo') &&
    (hasPhrase(haystack, 'improvisacion') || hasPhrase(haystack, 'musica en directo'))
  );
}

function classicalFirstHalf(facts: ObservedFacts, known: string[]): boolean {
  const program = fieldFolded(facts.programText) || fieldFolded(facts.description);
  if (!program) return false;
  const start = program.search(/primera parte|1\.?\s*a\.?\s*parte|first half/);
  if (start < 0) return false;
  const rest = program.slice(start + 1);
  const end = rest.search(/segunda parte|2\.?\s*a\.?\s*parte|second half/);
  const block = end >= 0 ? program.slice(start, start + 1 + end) : program.slice(start);
  if (findKnownComposersInText(block).length > 0) return true;
  return known.some((name) => hasPhrase(block, name));
}

function explicitClassicalConcertDeclaration(facts: ObservedFacts): Inclusion | undefined {
  const category = fieldFolded(facts.categoryText);
  const categoryName = foldName(facts.categoryText ?? '');
  if (
    categoryName === 'musica clasica' ||
    (hasWord(category, 'concierto') && hasPhrase(category, 'musica clasica'))
  ) {
    return {
      ruleId: 'explicit-classical-concert',
      evidence: [facts.categoryText ?? ''],
    };
  }
  const fields = [facts.description, facts.programText, facts.categoryText];
  for (const field of fields) {
    const folded = fieldFolded(field);
    if (!folded) continue;
    if (
      hasPhrase(folded, 'concierto de musica clasica') ||
      hasPhrase(folded, 'concierto de musica clasica espanola')
    ) {
      return {
        ruleId: 'explicit-classical-concert',
        evidence: [field ?? ''],
      };
    }
  }
  return undefined;
}

function describedClassicalPerformance(facts: ObservedFacts, _haystack: string): boolean {
  // Naming the theatre is not a declaration of the repertoire performed there.
  const description = fieldFolded(facts.description).replace(/\bteatro (?:de la )?zarzuela\b/g, '');
  if (!description) return false;
  const performs = /interpreta/.test(description);
  const repertoire =
    hasWord(description, 'opera') ||
    hasWord(description, 'zarzuela') ||
    hasPhrase(description, 'temas de zarzuela');
  return performs && repertoire;
}

function academicContemporary(facts: ObservedFacts, haystack: string): boolean {
  const title = foldName(facts.title);
  if (
    hasPhrase(haystack, 'festival coma') ||
    hasPhrase(title, 'coma 26')
  ) {
    return true;
  }
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
  const namedCycle = classicalSeriesIdentity(facts);
  const concertCue =
    hasWord(title, 'concierto') ||
    hasPhrase(haystack, 'serie de conciertos') ||
    (description.length > 0 && hasWord(description, 'conciertos')) ||
    Boolean(namedCycle);
  if (!concertCue) return undefined;

  const seriesCue =
    Boolean(namedCycle) ||
    hasPhrase(haystack, 'domingos de camara') ||
    hasPhrase(haystack, 'liceo de camara') ||
    hasPhrase(haystack, 'musica de camara') ||
    hasPhrase(haystack, 'festival de piano') ||
    hasPhrase(haystack, 'festival internacional de piano') ||
    hasPhrase(haystack, 'ciclo de organo') ||
    hasPhrase(haystack, 'conciertos de organo') ||
    hasPhrase(haystack, 'ciclo internacional de organo') ||
    hasPhrase(haystack, 'ciclo de grandes autores');
  if (!seriesCue) return undefined;

  return {
    ruleId: 'classical-concert-series',
    evidence: [namedCycle ?? facts.seriesText ?? facts.categoryText ?? facts.title],
  };
}

/**
 * Auditorio listings put the cycle in the event title and leave seriesText empty.
 * Only named classical cycles, never season codes (OCNE. Sinfónico 01) or
 * mixed series (Impacta, CNDM, La Filarmónica). Not description: a talk may
 * mention Universo Barroco.
 */
const TITLE_CLASSICAL_CYCLES = [
  'ibermusica',
  'fundacion scherzo',
  'festival alicia de larrocha',
  'festival internacional de piano',
];

function classicalSeriesIdentity(facts: ObservedFacts): string | undefined {
  const seriesFields = [facts.seriesText, facts.categoryText].filter(Boolean) as string[];
  for (const field of seriesFields) {
    const folded = fieldFolded(field);
    if (
      hasPhrase(folded, 'universo barroco') ||
      hasPhrase(folded, 'universo beethoven') ||
      hasPhrase(folded, 'series 20/21') ||
      hasPhrase(folded, 'series 20 21') ||
      hasPhrase(folded, 'liceo de camara') ||
      hasPhrase(folded, 'en clave de concierto') ||
      hasPhrase(folded, 'ciclo de lied') ||
      hasPhrase(folded, 'generacion musical del 27') ||
      hasPhrase(folded, 'bach vermut') ||
      hasPhrase(folded, 'les arts en madrid') ||
      hasPhrase(folded, 'fronteras') ||
      folded === 'lied' ||
      matchesTitleClassicalCycle(field)
    ) {
      return field;
    }
  }
  if (facts.title) {
    const title = foldName(facts.title);
    if (
      matchesTitleClassicalCycle(facts.title) ||
      hasPhrase(title, 'miniclasica descubriendo el clasicismo') ||
      hasPhrase(title, 'miniclasica descubriendo la musica antigua')
    ) {
      return facts.title;
    }
  }
  return undefined;
}

function matchesTitleClassicalCycle(text: string): boolean {
  const named = foldName(text);
  return TITLE_CLASSICAL_CYCLES.some((cycle) => named.includes(foldName(cycle)));
}

function isOperaCategory(category: string): boolean {
  return hasWord(category, 'opera') && !hasWord(category, 'taller');
}

function isOperaTitle(title: string): boolean {
  return hasWord(title, 'opera') || /\bmicroperas?\b/u.test(title);
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
  const editorial = [facts.programText, facts.description, facts.title, facts.seriesText]
    .filter(Boolean)
    .join('\n');
  for (const item of findKnownComposersInText(editorial)) {
    matched.push(item.canonicalName);
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
