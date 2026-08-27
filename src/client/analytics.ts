import posthog from 'posthog-js';

type AnalyticsProperties = Record<string, boolean | number | string | null | undefined>;

let initialized = false;

export function initClientAnalytics(key: string | undefined, host: string | undefined): boolean {
  if (initialized || !key) return initialized;
  posthog.init(key, {
    ...(host ? { api_host: host } : {}),
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    capture_exceptions: true,
    disable_session_recording: true,
    person_profiles: 'identified_only',
    respect_dnt: true,
  });
  initialized = true;
  return true;
}

export function identifyClientUser(
  id: string,
  properties: { role: string; team: string | null },
): void {
  if (!initialized) return;
  posthog.identify(id, properties);
}

export function resetClientUser(): void {
  if (initialized) posthog.reset();
}

export function captureClientEvent(event: string, properties: AnalyticsProperties = {}): void {
  if (initialized) posthog.capture(event, properties);
}

export function captureClientException(
  error: unknown,
  properties: AnalyticsProperties = {},
): void {
  if (initialized) posthog.captureException(error, properties);
}
