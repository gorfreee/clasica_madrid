import { foldName, hasPhrase, hasWord } from './text.ts';

/**
 * Official source category names this event as opera, not a workshop about
 * opera. Strong deterministic evidence for eligibility and formats.
 */
export function isOperaCategory(category: string): boolean {
  return hasWord(category, 'opera') && !hasWord(category, 'taller');
}

/**
 * The title names THIS event as opera (gala, temporada, micróperas, arias de
 * ópera, ópera en N actos, …). A project or company name that merely contains
 * the word is not enough: that must not freeze eligibility or formats.
 */
export function titleIdentifiesOperaEvent(title: string): boolean {
  if (!title) return false;
  if (/\bmicroperas?\b/u.test(title)) return true;
  if (
    hasPhrase(title, 'gala de opera') ||
    hasPhrase(title, 'ciclo de opera') ||
    hasPhrase(title, 'temporada de opera') ||
    hasPhrase(title, 'festival de opera') ||
    hasPhrase(title, 'opera en concierto') ||
    hasPhrase(title, 'opera de camara') ||
    hasPhrase(title, 'opera de camera') ||
    hasPhrase(title, 'chamber opera') ||
    hasPhrase(title, 'arias de opera') ||
    hasPhrase(title, 'arias de operas')
  ) {
    return true;
  }
  if (hasPhrase(title, 'opera en') && hasWord(title, 'actos')) return true;
  return titleIsOperaGenreLabel(title);
}

function titleIsOperaGenreLabel(title: string): boolean {
  const named = foldName(title);
  return (
    named === 'opera' ||
    named === 'la opera' ||
    named === 'el opera' ||
    named === 'una opera' ||
    named === 'the opera' ||
    named === 'operas' ||
    named === 'las operas'
  );
}
