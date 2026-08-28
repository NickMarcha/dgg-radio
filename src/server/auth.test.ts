import { describe, expect, it } from 'vitest';
import type { ServerEnv } from './env';
import { canModerate, radioRole } from './auth';

const env: ServerEnv = {
  DATABASE_URL: 'postgresql://unused',
  APP_ORIGIN: 'http://localhost:4321',
  PORT: 8787,
  DGG_CLIENT_ID: 'test-client',
  DGG_CLIENT_SECRET: 'test-secret',
  DGG_REDIRECT_URI: 'http://localhost:4321/auth/callback',
  ADMIN_DGG_USERNAMES: 'picklesnathan',
  YOUTUBE_API_KEY: 'test-key',
};

describe('radio roles', () => {
  it('grants admin only to a configured root admin', () => {
    expect(radioRole('picklesnathan', env)).toBe('admin');
    expect(radioRole('PicklesNathan', env)).toBe('admin');
    expect(radioRole('viewer', env)).toBe('listener');
  });

  it('allows mods and admins to moderate', () => {
    expect(canModerate('listener')).toBe(false);
    expect(canModerate('mod')).toBe(true);
    expect(canModerate('admin')).toBe(true);
  });
});
