import { z } from 'zod';

/** A variable set to an empty string is unset, which is how hosts spell "no value". */
const optional = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  PORT: z.coerce.number().int().positive().default(8787),
  POSTHOG_API_KEY: optional(z.string().min(1)),
  POSTHOG_HOST: optional(z.url()),
  DGG_CLIENT_ID: z.string().min(1),
  DGG_CLIENT_SECRET: z.string().min(1),
  DGG_REDIRECT_URI: z.url(),
  ADMIN_DGG_USERNAMES: z.string().default(''),
  YOUTUBE_API_KEY: z.string().min(1),
  APIFY_API_TOKEN: z.string().min(1),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | undefined;

export function getEnv(): ServerEnv {
  cachedEnv ??= envSchema.parse(process.env);
  return cachedEnv;
}

export function getAdminUsernames(env: ServerEnv): Set<string> {
  return new Set(
    env.ADMIN_DGG_USERNAMES.split(',')
      .map((username) => username.trim().toLowerCase())
      .filter(Boolean),
  );
}
