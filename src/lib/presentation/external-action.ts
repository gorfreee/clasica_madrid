import type { SourceKind } from '../schemas/taxonomies.ts';
import {
  eventOfficialSourceActionLabel,
  eventOriginalSourceActionLabel,
  eventSourceActionDescription,
  opensInNewTabLabel,
  venueOfficialWebLabel,
} from './labels.ts';

export type EventSourceRef = {
  url: string;
  kindId: SourceKind;
  isPrimary: boolean;
};

export type EventSourceActionModel = {
  href: string;
  label: string;
  description: string;
  isOfficial: boolean;
  accessibleLabel: string;
};

export type VenueOfficialWebModel = {
  href: string;
  label: string;
  accessibleLabel: string;
};

export function selectPrimarySource<T extends { isPrimary: boolean }>(sources: T[]): T | undefined {
  return sources.find((source) => source.isPrimary) ?? sources[0];
}

export function isOfficialSourceKind(kindId: SourceKind): boolean {
  return kindId === 'official';
}

export function buildEventSourceAction(sources: EventSourceRef[]): EventSourceActionModel | null {
  const source = selectPrimarySource(sources);
  if (!source) return null;

  const isOfficial = isOfficialSourceKind(source.kindId);
  const label = isOfficial ? eventOfficialSourceActionLabel : eventOriginalSourceActionLabel;
  const description = eventSourceActionDescription;

  return {
    href: source.url,
    label,
    description,
    isOfficial,
    accessibleLabel: `${label}. ${description}. ${opensInNewTabLabel}`,
  };
}

export function buildVenueOfficialWebAction(url: string | null | undefined): VenueOfficialWebModel | null {
  const href = url?.trim();
  if (!href) return null;

  return {
    href,
    label: venueOfficialWebLabel,
    accessibleLabel: `${venueOfficialWebLabel}. ${opensInNewTabLabel}`,
  };
}
