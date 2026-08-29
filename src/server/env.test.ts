import { describe, expect, it } from 'vitest';
import { DGG_ORIGIN, parseEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://unused',
  APP_ORIGIN: 'http://localhost:4321',
  DGG_CLIENT_ID: 'test-client',
  DGG_CLIENT_SECRET: 'test-secret',
  DGG_REDIRECT_URI: 'http://localhost:4321/auth/callback',
  YOUTUBE_API_KEY: 'test-key',
};

const standIn = {
  DGG_ORIGIN: 'http://dgg-oauth:8788',
  DGG_AUTHORIZE_ORIGIN: 'http://localhost:8788',
};

describe('the OAuth provider origins', () => {
  it('are Destiny when nothing sets them', () => {
    const env = parseEnv(base);
    expect(env.DGG_ORIGIN).toBe(DGG_ORIGIN);
    expect(env.DGG_AUTHORIZE_ORIGIN).toBe(DGG_ORIGIN);
  });

  it('accept the local stand-in for a room served over http', () => {
    expect(parseEnv({ ...base, ...standIn }).DGG_ORIGIN).toBe(standIn.DGG_ORIGIN);
  });

  it('refuse the local stand-in once the room is served over https', () => {
    const deployed = { ...base, APP_ORIGIN: 'https://dgg-radio.netlify.app', ...standIn };
    expect(() => parseEnv(deployed)).toThrow(/development only/);
  });

  it('refuse a stand-in reached only by the browser', () => {
    const deployed = {
      ...base,
      APP_ORIGIN: 'https://dgg-radio.netlify.app',
      DGG_AUTHORIZE_ORIGIN: standIn.DGG_AUTHORIZE_ORIGIN,
    };
    expect(() => parseEnv(deployed)).toThrow(/DGG_AUTHORIZE_ORIGIN/);
  });
});
