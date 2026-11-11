import type { ShareContentType, ShareMethod } from '../presentation/share.ts';

export const CONTENT_SHARED_EVENT = 'content_shared';

export type ContentSharedProperties = {
  method: ShareMethod;
  content_type: ShareContentType;
  path: string;
};

/** Values PostHog can store without nested objects. Callers must already drop PII. */
export type AnalyticsValue = string | number | boolean;

export type AnalyticsProperties = Record<string, AnalyticsValue>;

export type AnalyticsCapture = (event: string, properties: AnalyticsProperties) => void;

/**
 * Sends one custom event. Missing PostHog, a missing token, or a thrown
 * capture become a no-op. The call is synchronous and is never awaited.
 */
export function captureAnalytics(
  event: string,
  properties: AnalyticsProperties,
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!capture) return;
  try {
    capture(event, properties);
  } catch {
    // Analytics must not affect the user action.
  }
}

/**
 * Records a completed share. Missing PostHog, a missing token, or a thrown
 * capture become a no-op so sharing keeps working.
 */
export function captureContentShared(
  properties: ContentSharedProperties,
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  captureAnalytics(
    CONTENT_SHARED_EVENT,
    {
      method: properties.method,
      content_type: properties.content_type,
      path: properties.path,
    },
    capture,
  );
}

export function defaultCapture(): AnalyticsCapture | null {
  if (typeof window === 'undefined') return null;
  const posthog = (window as Window & { posthog?: { capture?: unknown } }).posthog;
  if (!posthog || typeof posthog.capture !== 'function') return null;
  const capture = posthog.capture.bind(posthog) as AnalyticsCapture;
  return (event, properties) => {
    capture(event, properties);
  };
}

/** Drops `undefined` so optional analytics fields stay out of the payload. `false` and `0` stay. */
export function definedProperties(
  properties: Record<string, AnalyticsValue | undefined>,
): AnalyticsProperties {
  const defined: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}
