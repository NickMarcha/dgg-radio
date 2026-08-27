import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.url(),
  PORT: z.coerce.number().int().positive().default(8787),
  POSTHOG_API_KEY: z.string().min(1).optional(),
  POSTHOG_HOST: z.url().optional(),
  DGG_CLIENT_ID: z.string().min(1),
  DGG_CLIENT_SECRET: z.string().min(1),
  DGG_REDIRECT_URI: z.url(),
  ADMIN_DGG_USERNAMES: z.string().default(''),
  YOUTUBE_API_KEY: z.string().min(1),
  SOUNDCLOUD_CLIENT_ID: z.string().min(1),
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
