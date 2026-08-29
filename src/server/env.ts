import { z } from 'zod';

/** A variable set to an empty string is unset, which is how hosts spell "no value". */
const optional = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** Destiny.gg itself, which is the only provider a deployed room may use. */
export const DGG_ORIGIN = 'https://www.destiny.gg';

/**
 * The provider is two addresses rather than one because the local stand-in in
 * `dev/dgg-oauth` runs in its own container: the API calls it over the compose
 * network, while the browser is redirected to its published port. Both default
 * to Destiny, so a deployment that sets neither talks to the real site.
 */
const providerOrigin = z.preprocess(
  (value) => (value === '' || value === undefined ? DGG_ORIGIN : value),
  z.url(),
);

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.url(),
    PORT: z.coerce.number().int().positive().default(8787),
    POSTHOG_API_KEY: optional(z.string().min(1)),
    POSTHOG_HOST: optional(z.url()),
    DGG_CLIENT_ID: z.string().min(1),
    DGG_CLIENT_SECRET: z.string().min(1),
    DGG_REDIRECT_URI: z.url(),
    /** Where the API fetches the token and the user profile. */
    DGG_ORIGIN: providerOrigin,
    /** Where the browser is sent to authorize. */
    DGG_AUTHORIZE_ORIGIN: providerOrigin,
    ADMIN_DGG_USERNAMES: z.string().default(''),
    YOUTUBE_API_KEY: z.string().min(1),
  })
  .superRefine((env, context) => {
    // The stand-in signs anyone in as anyone, so a deployed room reaching one
    // would be an open door. A local room is served over http and a deployed
    // one over https, which is the only distinction the process can make on
    // its own, so it is the one that decides.
    if (!env.APP_ORIGIN.startsWith('https://')) return;
    for (const key of ['DGG_ORIGIN', 'DGG_AUTHORIZE_ORIGIN'] as const) {
      if (env[key] === DGG_ORIGIN) continue;
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must be ${DGG_ORIGIN} when APP_ORIGIN is https. The local Destiny stand-in is for development only.`,
      });
    }
  });

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | undefined;

export function parseEnv(source: Record<string, unknown>): ServerEnv {
  return envSchema.parse(source);
}

export function getEnv(): ServerEnv {
  cachedEnv ??= parseEnv(process.env);
  return cachedEnv;
}

export function getAdminUsernames(env: ServerEnv): Set<string> {
  return new Set(
    env.ADMIN_DGG_USERNAMES.split(',')
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean),
  );
}
