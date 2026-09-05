import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

// The threshold is the thing under test, so it is mocked to a value each test
// chooses rather than waited out in real time.
const threshold = { ms: 0 };

vi.mock('./analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics')>()),
  captureServerEvent: vi.fn(),
  captureServerException: vi.fn(),
  captureSlowRequest: vi.fn(),
  get SLOW_REQUEST_MS() {
    return threshold.ms;
  },
}));

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  getSessionUser: vi.fn().mockResolvedValue(null),
}));

const { captureSlowRequest } = await import('./analytics');
const { createApp } = await import('./app');

const app = createApp({
  listenerCount: () => 0,
  eligibleVoterCount: () => 0,
  operationsSnapshot: () => ({}) as never,
  onRoomChanged: () => {},
});

describe('slow request reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threshold.ms = 0;
  });

  it('reports a request that crosses the threshold, by its registered route', async () => {
    const response = await app.request('/api/rules/abc/entries');

    expect(response.status).toBe(401);
    expect(captureSlowRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSlowRequest).mock.calls[0]?.[0]).toMatchObject({
      // The id it was asked for does not appear: a thousand ids would otherwise
      // become a thousand routes.
      route: '/api/rules/:id/entries',
      method: 'GET',
      status: 401,
    });
  });

  it('reports how long the request took', async () => {
    await app.request('/api/rules/abc/entries');

    const [call] = vi.mocked(captureSlowRequest).mock.calls;
    expect(call?.[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('says nothing about a request that stays under the threshold', async () => {
    threshold.ms = 60_000;

    const response = await app.request('/api/rules/abc/entries');

    expect(response.status).toBe(401);
    expect(captureSlowRequest).not.toHaveBeenCalled();
  });
});
