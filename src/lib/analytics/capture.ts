import type { ShareContentType, ShareMethod } from '../presentation/share.ts';

export const CONTENT_SHARED_EVENT = 'content_shared';

export type ContentSharedProperties = {
  method: ShareMethod;
  content_type: ShareContentType;
  path: string;
};

type AnalyticsCapture = (event: string, properties: ContentSharedProperties) => void;

/**
 * Records a completed share. Missing PostHog, a missing token, or a thrown
 * capture become a no-op so sharing keeps working.
 */
export function captureContentShared(
  properties: ContentSharedProperties,
  capture: AnalyticsCapture | null = defaultCapture(),
): void {
  if (!capture) return;
  try {
    capture(CONTENT_SHARED_EVENT, {
      method: properties.method,
      content_type: properties.content_type,
      path: properties.path,
    });
  } catch {
    // Analytics must not affect the share action.
  }
}

function defaultCapture(): AnalyticsCapture | null {
  if (typeof window === 'undefined') return null;
  const posthog = (window as Window & { posthog?: { capture?: unknown } }).posthog;
  if (!posthog || typeof posthog.capture !== 'function') return null;
  const capture = posthog.capture.bind(posthog) as AnalyticsCapture;
  return (event, properties) => {
    capture(event, properties);
  };
}
