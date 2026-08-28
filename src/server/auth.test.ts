import { describe, expect, it } from 'vitest';
import type { ServerEnv } from './env';
import { canModerate, radioRole, teamFromFeatures } from './auth';

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

describe('teamFromFeatures', () => {
  it('maps the production Destiny team flair features', () => {
    expect(teamFromFeatures(['flair35'])).toBe('pepe');
    expect(teamFromFeatures(['flair36'])).toBe('yee');
  });

  it('does not guess if both or neither team feature is present', () => {
    expect(teamFromFeatures([])).toBeNull();
    expect(teamFromFeatures(['flair35', 'flair36'])).toBeNull();
  });
});

describe('radio roles', () => {
  it('keeps Destiny moderators separate from admins', () => {
    expect(radioRole('viewer', ['MODERATOR'], env)).toBe('mod');
    expect(radioRole('viewer', ['ADMIN'], env)).toBe('admin');
    expect(radioRole('picklesnathan', [], env)).toBe('admin');
    expect(radioRole('viewer', [], env)).toBe('listener');
  });

  it('allows mods and admins to moderate', () => {
    expect(canModerate('listener')).toBe(false);
    expect(canModerate('mod')).toBe(true);
    expect(canModerate('admin')).toBe(true);
  });
});
