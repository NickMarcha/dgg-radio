import { PostHog } from 'posthog-node';
import { getEnv } from './env';

type AnalyticsProperties = Record<string, boolean | number | string | null | undefined>;

let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;
  const env = getEnv();
  client = env.POSTHOG_PROJECT_KEY
    ? new PostHog(env.POSTHOG_PROJECT_KEY, {
        host: env.POSTHOG_HOST,
        flushAt: 20,
        flushInterval: 5_000,
        enableExceptionAutocapture: true,
      })
    : null;
  return client;
}

export function captureServerEvent(
  distinctId: string,
  event: string,
  properties: AnalyticsProperties = {},
): void {
  getClient()?.capture({
    distinctId,
    event,
    properties: {
      service: 'dgg-radio-api',
      ...properties,
    },
  });
}

export function captureServerException(
  error: unknown,
  distinctId: string | undefined,
  properties: AnalyticsProperties = {},
): void {
  getClient()?.captureException(error, distinctId, {
    service: 'dgg-radio-api',
    ...properties,
  });
}

/**
 * How long an API request may take before it is worth a line in PostHog. Well
 * above anything the room does when it is healthy — the slowest endpoint is the
 * stats page at a quarter of a second — so a healthy server reports nothing at
 * all and the room's fifteen-second poll never writes an event.
 *
 * This is the time the server spent producing the response, not the time the
 * listener waited for it. The two differ by the network and, in production, by
 * the Cloudflare tunnel: a request the server answered in a second may still
 * reach nobody. Cloudflare gives up on an origin after 125 seconds, which
 * nothing here comes close to, so the gap is currently a caveat on the number
 * rather than a fault it can detect.
 */
export const SLOW_REQUEST_MS = 1_000;

/**
 * Records a request that took longer than {@link SLOW_REQUEST_MS}. Only the
 * slow ones, so the volume is a handful of events when something is wrong and
 * none when nothing is.
 */
export function captureSlowRequest(properties: {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  userId?: string;
}): void {
  const { userId, durationMs, ...rest } = properties;
  captureServerEvent(userId ?? 'dgg-radio-api', 'api_request_slow', {
    ...rest,
    duration_ms: Math.round(durationMs),
    threshold_ms: SLOW_REQUEST_MS,
  });
}

export async function shutdownServerAnalytics(): Promise<void> {
  await getClient()?.shutdown(2_000);
}
