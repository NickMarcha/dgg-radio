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

export async function shutdownServerAnalytics(): Promise<void> {
  await getClient()?.shutdown(2_000);
}
