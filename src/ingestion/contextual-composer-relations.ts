/**
 * Historical or stylistic relations that name a composer without attributing
 * a work on the current programme. Shared by the knowledge scanner and the
 * attribution scanner so the common list cannot drift. Attribution-only
 * credits (libreto, alumno de, …) stay in `composer-attribution.ts`.
 */
export const CONTEXTUAL_COMPOSER_RELATIONS = [
  'tema de',
  'un tema de',
  'sobre un tema de',
  'basado en',
  'basada en',
  'inspirado en',
  'inspirada en',
  'homenaje a',
  'en homenaje a',
  'heredero de',
  'heredera de',
  'herederos de',
  'herederas de',
] as const;
