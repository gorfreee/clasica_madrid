export const ENTITY_COLLECTIONS = [
  'events',
  'venues',
  'organizers',
  'series',
  'sources',
] as const;

export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];
