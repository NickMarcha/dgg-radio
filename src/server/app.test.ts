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

vi.mock('./station', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./station')>()),
  stationOfQueueItem: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000001'),
  blockQueueItemMedia: vi.fn(),
  removeQueuedTrack: vi.fn(),
  reorderStationQueue: vi.fn(),
  skipCurrentTrack: vi.fn(),
  voteOnCurrentTrack: vi.fn(),
  withdrawQueuedTrack: vi.fn(),
}));

vi.mock('./rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rules')>()),
  reorderRules: vi.fn(),
}));

vi.mock('./stations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stations')>()),
  stationRoleOf: vi.fn(),
  stationAccessOf: vi.fn().mockResolvedValue({ owned: [{ slug: 'late-night', name: 'Late Night' }], canCreate: false }),
  setStationModerator: vi.fn(),
  findStationIdBySlug: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000001'),
}));

vi.mock('./admins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admins')>()),
  listUsers: vi.fn().mockResolvedValue([]),
  setStationCreator: vi.fn(),
  setUserRole: vi.fn(),
}));

vi.mock('./media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media')>()),
  searchMedia: vi.fn().mockResolvedValue([]),
}));

vi.mock('./storage', () => ({
  getStorageSnapshot: vi.fn(),
}));

vi.mock('./playlists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./playlists')>()),
  addPlaylistTrackByUrl: vi.fn(),
  createPlaylist: vi.fn(),
  queuePlaylistTrack: vi.fn(),
}));

vi.mock('./watcher-embeds', () => ({
  findWatcherEmbedSettings: vi.fn(),
  getOrCreateWatcherEmbedSettings: vi.fn(),
  updateWatcherEmbedSettings: vi.fn(),
}));

const { getSessionUser } = await import('./auth');
const { setUserRole } = await import('./admins');
const { reorderRules } = await import('./rules');
const { getStorageSnapshot } = await import('./storage');
const { resetRateLimits } = await import('./rate-limit');
const { addPlaylistTrackByUrl, createPlaylist, queuePlaylistTrack } = await import('./playlists');
const { findStationIdBySlug, MAIN_STATION_ID, stationRoleOf, setStationModerator } = await import('./stations');
const { setStationCreator } = await import('./admins');
const {
  findWatcherEmbedSettings,
  getOrCreateWatcherEmbedSettings,
  updateWatcherEmbedSettings,
} = await import('./watcher-embeds');
const {
  blockQueueItemMedia,
  removeQueuedTrack,
  reorderStationQueue,
  skipCurrentTrack,
  voteOnCurrentTrack,
  withdrawQueuedTrack,
} = await import('./station');
const { createApp } = await import('./app');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const QUEUE_ID = '00000000-0000-4000-8000-000000000002';
const RULE_ID = '00000000-0000-4000-8000-000000000003';
const PLAYLIST_ID = '00000000-0000-4000-8000-000000000004';
const MEDIA_ID = '00000000-0000-4000-8000-000000000005';

const watcherEmbedSettings = {
  ownerId: USER_ID,
  show: 'speakers' as const,
  window: 10,
  max: 12,
  layout: 'float' as const,
  names: 'under' as const,
  enter: 'fade' as const,
  motion: 'drift' as const,
  color: 'flair' as const,
  speed: 100,
  size: 100,
  roam: 100,
  inset: 4,
  updatedAt: '2026-09-05T21:00:00.000Z',
};

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

function request(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
    body: JSON.stringify(body),
  });
}

const storageSnapshot = {
  databaseBytes: 12_582_912,
  groups: [
    {
      name: 'Track catalogue and provider cache',
      tables: ['media', 'media_lookups', 'playback_regions'],
      rowCount: 412,
      tableBytes: 4_194_304,
      indexBytes: 1_048_576,
      totalBytes: 5_242_880,
      share: 5_242_880 / 12_582_912,
    },
  ],
};
vi.mocked(getStorageSnapshot).mockResolvedValue(storageSnapshot);

const onStationChanged = vi.fn();
const operationsSnapshot = vi.fn(() => ({
  capturedAt: '2026-08-30T03:01:00.000Z',
  processStartedAt: '2026-08-30T03:00:00.000Z',
  socketCount: 2,
  listenerCount: 1,
  eligibleVoterCount: 1,
  connections: [],
  clock: {
    checks: 60,
    advances: 1,
    lastCheckedAt: '2026-08-30T03:01:00.000Z',
    lastAdvancedAt: '2026-08-30T03:00:30.000Z',
  },
}));
const app = createApp({
  listenerCount: () => 1,
  eligibleVoterCount: () => 3,
  operationsSnapshot,
  onStationChanged,
});

describe('role authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A site admin owns every station; anyone else holds whatever a test gives them.
    vi.mocked(stationRoleOf).mockImplementation(async (who) =>
      who?.role === 'admin' ? 'owner' : null,
    );
  });

  /** A listener who moderates the main station, which is a station role rather than a site one. */
  function asStationMod() {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(stationRoleOf).mockResolvedValue('mod');
  }

  it('allows a mod to block, skip, and reorder the station queue', async () => {
    asStationMod();

    expect(
      (await request(`/api/queue/${QUEUE_ID}/block`, 'POST', {
        ruleIds: [RULE_ID],
        entryType: 'track',
      })).status,
    ).toBe(200);
    expect(
      (await request('/api/stations/main/current/skip', 'POST', { reason: 'Wrong station for this track' })).status,
    ).toBe(200);
    expect(
      (await request('/api/stations/main/queue/station-order', 'PATCH', { orderedIds: [QUEUE_ID] })).status,
    ).toBe(200);

    expect(blockQueueItemMedia).toHaveBeenCalledOnce();
    expect(skipCurrentTrack).toHaveBeenCalledOnce();
    expect(reorderStationQueue).toHaveBeenCalledOnce();
  });

  it('does not let a mod remove tracks or use admin endpoints', async () => {
    asStationMod();

    expect(
      (await request(`/api/queue/${QUEUE_ID}/remove`, 'POST', { reason: 'Remove this track' })).status,
    ).toBe(403);
    expect((await app.request('/api/users')).status).toBe(403);
    expect((await request('/api/stations/main/rules/order', 'PATCH', { orderedIds: [RULE_ID] })).status).toBe(403);
    expect(removeQueuedTrack).not.toHaveBeenCalled();
    expect(reorderRules).not.toHaveBeenCalled();
  });

  it('rejects moderation actions from listeners', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    const response = await request('/api/stations/main/queue/station-order', 'PATCH', { orderedIds: [QUEUE_ID] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'MODERATOR_REQUIRED' } });
    expect(reorderStationQueue).not.toHaveBeenCalled();
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

  it('uses distinct signed-in station listeners as the skip-ratio denominator', async () => {
    const listener = user('listener');
    vi.mocked(getSessionUser).mockResolvedValue(listener);

    const response = await request(`/api/queue/${QUEUE_ID}/vote`, 'POST', { value: -1 });

    expect(response.status).toBe(200);
    expect(voteOnCurrentTrack).toHaveBeenCalledWith(QUEUE_ID, -1, listener, 3);
  });

  it('lets an admin assign the admin role', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request(`/api/users/${USER_ID}/role`, 'PATCH', { role: 'admin' });
    expect(response.status).toBe(200);
    expect(setUserRole).toHaveBeenCalledWith(USER_ID, 'admin');
  });

  it('no longer takes mod as a site role', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request(`/api/users/${USER_ID}/role`, 'PATCH', { role: 'mod' });
    expect(response.status).toBe(400);
    expect(setUserRole).not.toHaveBeenCalled();
  });

  it("lets a station's owner pick its moderators, and nobody below that", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(stationRoleOf).mockResolvedValue('owner');
    const path = '/api/stations/main/moderators/radio_user';

    expect((await request(path, 'PUT', { moderator: true })).status).toBe(200);
    expect(setStationModerator).toHaveBeenCalledWith(MAIN_STATION_ID, 'radio_user', true, user('listener'));

    asStationMod();
    expect((await request(path, 'PUT', { moderator: true })).status).toBe(403);
    expect(setStationModerator).toHaveBeenCalledOnce();
  });

  it('keeps the station creator whitelist to site admins', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(stationRoleOf).mockResolvedValue('owner');
    const path = `/api/users/${USER_ID}/station-creator`;

    expect((await request(path, 'PATCH', { canCreateStations: true })).status).toBe(403);
    expect(setStationCreator).not.toHaveBeenCalled();

    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));
    expect((await request(path, 'PATCH', { canCreateStations: true })).status).toBe(200);
    expect(setStationCreator).toHaveBeenCalledWith(USER_ID, true);
  });

  it('routes an admin rule reorder past the /api/rules/:id handler', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request('/api/stations/main/rules/order', 'PATCH', { orderedIds: [RULE_ID] });
    expect(response.status).toBe(200);
    expect(reorderRules).toHaveBeenCalledWith(MAIN_STATION_ID, [RULE_ID]);
  });
});

describe('stations by name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 404 for a station that does not exist, before asking anything of it', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(findStationIdBySlug).mockResolvedValueOnce(null);

    const response = await request('/api/stations/nowhere/queue', 'POST', {
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'STATION_NOT_FOUND' } });
  });
});

describe('the header session endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the signed-in listener without the station snapshot behind it', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

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
        role: 'listener',
        team: null,
      },
      stations: { owned: [{ slug: 'late-night', name: 'Late Night' }], canCreate: false },
    });
  });

  it('answers for an anonymous viewer rather than refusing', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await app.request('/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listenerCount: 1,
      me: null,
      stations: { owned: [], canCreate: false },
    });
  });
});

describe('the operations endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the current server snapshot to an admin', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await app.request('/api/operations');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...operationsSnapshot(), storage: storageSnapshot });
  });

  it('does not expose connection details or storage to listeners', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    const response = await app.request('/api/operations');

    expect(response.status).toBe(403);
    expect(operationsSnapshot).not.toHaveBeenCalled();
    expect(getStorageSnapshot).not.toHaveBeenCalled();
  });
});

describe('personal watcher sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stationRoleOf).mockImplementation(async (who) =>
      who?.role === 'admin' ? 'owner' : null,
    );
    vi.mocked(findWatcherEmbedSettings).mockResolvedValue(watcherEmbedSettings);
    vi.mocked(getOrCreateWatcherEmbedSettings).mockResolvedValue(watcherEmbedSettings);
    vi.mocked(updateWatcherEmbedSettings).mockResolvedValue(watcherEmbedSettings);
  });

  it('lets an OBS source read settings without a session or a cache', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await app.request(`/api/watcher-embeds/${USER_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual(watcherEmbedSettings);
    expect(findWatcherEmbedSettings).toHaveBeenCalledWith(USER_ID);
  });

  it('does not create a row for an invented public source id', async () => {
    vi.mocked(findWatcherEmbedSettings).mockResolvedValue(null);

    const response = await app.request(`/api/watcher-embeds/${USER_ID}`);

    expect(response.status).toBe(404);
    expect(getOrCreateWatcherEmbedSettings).not.toHaveBeenCalled();
  });

  it('creates and returns the signed-in admin source', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await app.request('/api/stations/main/watcher-embed');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(getOrCreateWatcherEmbedSettings).toHaveBeenCalledWith(USER_ID);
  });

  it('saves only the signed-in admin source', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('admin'));

    const response = await request('/api/stations/main/watcher-embed', 'PATCH', {
      layout: 'climb',
      max: 10,
    });

    expect(response.status).toBe(200);
    expect(updateWatcherEmbedSettings).toHaveBeenCalledWith(USER_ID, {
      layout: 'climb',
      max: 10,
    });
  });

  it('does not let a listener create or edit a source', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    expect((await app.request('/api/stations/main/watcher-embed')).status).toBe(403);
    expect((await request('/api/stations/main/watcher-embed', 'PATCH', { layout: 'safe' })).status).toBe(403);
    expect(getOrCreateWatcherEmbedSettings).not.toHaveBeenCalled();
    expect(updateWatcherEmbedSettings).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
  });

  it('refuses a signed-in user who searches too fast, and says when to come back', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await app.request('/api/search?q=hello')).status).toBe(200);
    }

    const refused = await app.request('/api/search?q=hello');

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  // One person spending their allowance must not spend anybody else's.
  it('counts each person separately', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await app.request('/api/search?q=hello');
    }

    vi.mocked(getSessionUser).mockResolvedValue({
      ...user('listener'),
      id: '00000000-0000-4000-8000-0000000000ff',
    });

    expect((await app.request('/api/search?q=hello')).status).toBe(200);
  });

  // Searching hard should not cost somebody their ability to queue a track.
  it('keeps a separate allowance per kind of request', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await app.request('/api/search?q=hello');
    }

    const queued = await request('/api/stations/main/queue', 'POST', {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    expect(queued.status).not.toBe(429);
  });
});

describe('personal playlist routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a private playlist without notifying the station', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(createPlaylist).mockResolvedValue(PLAYLIST_ID);

    const response = await request('/api/playlists', 'POST', { name: 'Driving' });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: PLAYLIST_ID });
    expect(createPlaylist).toHaveBeenCalledWith('Driving', USER_ID);
    expect(onStationChanged).not.toHaveBeenCalled();
  });

  it('saves a pasted link into a playlist without notifying the station', async () => {
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
    expect(onStationChanged).not.toHaveBeenCalled();
  });

  // The browser preflights a cross-origin PUT, so leaving it out of the allowed
  // methods silently blocked every save from the station and history pages.
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

  it('queues an owned playlist track and notifies the station', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('listener'));
    vi.mocked(queuePlaylistTrack).mockResolvedValue({
      id: QUEUE_ID,
      provider: 'youtube',
      durationSeconds: 120,
    });

    const response = await request(
      `/api/stations/main/playlists/${PLAYLIST_ID}/tracks/${MEDIA_ID}/queue`,
      'POST',
      {},
    );

    expect(response.status).toBe(201);
    expect(queuePlaylistTrack).toHaveBeenCalledWith(
      MAIN_STATION_ID,
      PLAYLIST_ID,
      MEDIA_ID,
      user('listener'),
    );
    expect(onStationChanged).toHaveBeenCalledOnce();
  });
});
