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

vi.mock('./playlists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./playlists')>()),
  addPlaylistTrackByUrl: vi.fn(),
  createPlaylist: vi.fn(),
  queuePlaylistTrack: vi.fn(),
}));

const { getSessionUser } = await import('./auth');
const { setUserRole } = await import('./admins');
const { reorderRules } = await import('./rules');
const { addPlaylistTrackByUrl, createPlaylist, queuePlaylistTrack } = await import('./playlists');
const { blockQueueItemMedia, removeQueuedTrack, reorderRoomQueue, skipCurrentTrack, withdrawQueuedTrack } =
  await import('./room');
const { createApp } = await import('./app');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const QUEUE_ID = '00000000-0000-4000-8000-000000000002';
const RULE_ID = '00000000-0000-4000-8000-000000000003';
const PLAYLIST_ID = '00000000-0000-4000-8000-000000000004';
const MEDIA_ID = '00000000-0000-4000-8000-000000000005';

function user(role: AuthenticatedUser['role']): AuthenticatedUser {
  return {
    id: USER_ID,
    dggUserId: 'dgg-user',
    username: 'radio_user',
    avatarUrl: null,
    role,
    team: null,
    flair: null,
    topEmote: null,
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

const onRoomChanged = vi.fn();
const app = createApp({ listenerCount: () => 1, onRoomChanged });

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

describe('the header session endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the signed-in listener without the room snapshot behind it', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('mod'));

    const response = await app.request('/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listenerCount: 1,
      me: {
        id: USER_ID,
        username: 'radio_user',
        avatarUrl: null,
        flair: null,
        topEmote: null,
        role: 'mod',
        team: null,
      },
    });
  });

  it('answers for an anonymous viewer rather than refusing', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await app.request('/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ listenerCount: 1, me: null });
  });
});

describe('personal playlist routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a private playlist without notifying the room', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(createPlaylist).mockResolvedValue(PLAYLIST_ID);

    const response = await request('/api/playlists', 'POST', { name: 'Driving' });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: PLAYLIST_ID });
    expect(createPlaylist).toHaveBeenCalledWith('Driving', USER_ID);
    expect(onRoomChanged).not.toHaveBeenCalled();
  });

  it('saves a pasted link into a playlist without notifying the room', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(addPlaylistTrackByUrl).mockResolvedValue({ attempted: 1, saved: 1, duplicates: 0, skipped: [] });

    const response = await request(`/api/playlists/${PLAYLIST_ID}/tracks`, 'POST', {
      url: 'https://www.youtube.com/watch?v=ccccccccccc',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ attempted: 1, saved: 1, duplicates: 0, skipped: [] });
    expect(addPlaylistTrackByUrl).toHaveBeenCalledWith(
      PLAYLIST_ID,
      'https://www.youtube.com/watch?v=ccccccccccc',
      USER_ID,
    );
    expect(onRoomChanged).not.toHaveBeenCalled();
  });

  // The browser preflights a cross-origin PUT, so leaving it out of the allowed
  // methods silently blocked every save from the room and history pages.
  it('lets the browser preflight the PUT that saves a track', async () => {
    const response = await app.request(`/api/playlists/${PLAYLIST_ID}/tracks/${MEDIA_ID}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4321',
        'Access-Control-Request-Method': 'PUT',
      },
    });

    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
  });

  it('queues an owned playlist track and notifies the room', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(queuePlaylistTrack).mockResolvedValue({
      id: QUEUE_ID,
      provider: 'youtube',
      durationSeconds: 120,
    });

    const response = await request(
      `/api/playlists/${PLAYLIST_ID}/tracks/${MEDIA_ID}/queue`,
      'POST',
      {},
    );

    expect(response.status).toBe(201);
    expect(queuePlaylistTrack).toHaveBeenCalledWith(PLAYLIST_ID, MEDIA_ID, user('listener'));
    expect(onRoomChanged).toHaveBeenCalledOnce();
  });
});
