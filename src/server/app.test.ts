import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './auth';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  getSessionUser: vi.fn(),
}));

vi.mock('./room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room')>()),
  blockQueueItemMedia: vi.fn(),
  removeQueuedTrack: vi.fn(),
  reorderRoomQueue: vi.fn(),
  skipCurrentTrack: vi.fn(),
  withdrawQueuedTrack: vi.fn(),
}));

vi.mock('./rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rules')>()),
  reorderRules: vi.fn(),
}));

vi.mock('./admins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admins')>()),
  listUsers: vi.fn().mockResolvedValue([]),
  setUserRole: vi.fn(),
}));

const { getSessionUser } = await import('./auth');
const { setUserRole } = await import('./admins');
const { reorderRules } = await import('./rules');
const { blockQueueItemMedia, removeQueuedTrack, reorderRoomQueue, skipCurrentTrack, withdrawQueuedTrack } =
  await import('./room');
const { createApp } = await import('./app');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const QUEUE_ID = '00000000-0000-4000-8000-000000000002';
const RULE_ID = '00000000-0000-4000-8000-000000000003';

function user(role: AuthenticatedUser['role']): AuthenticatedUser {
  return {
    id: USER_ID,
    dggUserId: 'dgg-user',
    username: 'radio_user',
    avatarUrl: null,
    role,
    team: null,
    dggRoles: [],
    dggFeatures: [],
  };
}

function request(path: string, method: 'POST' | 'PATCH', body: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
}

const app = createApp({ listenerCount: () => 1, onRoomChanged: vi.fn() });

describe('role authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a mod to block, skip, and reorder the room queue', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('mod'));

    expect(
      (await request(`/api/queue/${QUEUE_ID}/block`, 'POST', {
        ruleIds: [RULE_ID],
        entryType: 'track',
      })).status,
    ).toBe(200);
    expect(
      (await request('/api/current/skip', 'POST', { reason: 'Wrong room for this track' })).status,
    ).toBe(200);
    expect(
      (await request('/api/queue/room-order', 'PATCH', { orderedIds: [QUEUE_ID] })).status,
    ).toBe(200);

    expect(blockQueueItemMedia).toHaveBeenCalledOnce();
    expect(skipCurrentTrack).toHaveBeenCalledOnce();
    expect(reorderRoomQueue).toHaveBeenCalledOnce();
  });

  it('does not let a mod remove tracks or use admin endpoints', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('mod'));

    expect(
      (await request(`/api/queue/${QUEUE_ID}/remove`, 'POST', { reason: 'Remove this track' })).status,
    ).toBe(403);
    expect((await app.request('/api/users')).status).toBe(403);
    expect((await request('/api/rules/order', 'PATCH', { orderedIds: [RULE_ID] })).status).toBe(403);
    expect(removeQueuedTrack).not.toHaveBeenCalled();
    expect(reorderRules).not.toHaveBeenCalled();
  });

  it('rejects moderation actions from listeners', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    const response = await request('/api/queue/room-order', 'PATCH', { orderedIds: [QUEUE_ID] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'MODERATOR_REQUIRED' } });
    expect(reorderRoomQueue).not.toHaveBeenCalled();
  });

  it('lets any signed-in listener take back their own queued track', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    const response = await app.request(`/api/queue/${QUEUE_ID}`, {
      method: 'DELETE',
      headers: { Origin: 'http://localhost:4321' },
    });

    expect(response.status).toBe(200);
    expect(withdrawQueuedTrack).toHaveBeenCalledOnce();
  });

  it('lets an admin assign the mod role', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request(`/api/users/${USER_ID}/role`, 'PATCH', { role: 'mod' });
    expect(response.status).toBe(200);
    expect(setUserRole).toHaveBeenCalledWith(USER_ID, 'mod');
  });

  it('routes an admin rule reorder past the /api/rules/:id handler', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request('/api/rules/order', 'PATCH', { orderedIds: [RULE_ID] });
    expect(response.status).toBe(200);
    expect(reorderRules).toHaveBeenCalledWith([RULE_ID]);
  });
});
