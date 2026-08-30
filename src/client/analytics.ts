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
    // Recording is on, but PostHog only keeps a session where an `$exception`
    // was captured: the recorder holds the session in memory and uploads it
    // when the trigger fires, so a visit where nothing broke is never sent and
    // the lead-up to one that did is not lost. The trigger lives in the
    // project's replay settings, not here, so this reads as "record everything"
    // on its own.
    //
    // Input values are masked by default and stay that way. Anything worth
    // knowing that a person typed is attached to the error instead, which is
    // exact rather than pixels and costs nobody else their privacy.
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
