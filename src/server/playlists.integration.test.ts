import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './auth';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { cachedLookup, playbackIssues } = vi.hoisted(() => ({
  cachedLookup: vi.fn(),
  /** URLs the room cannot play. Their metadata still resolves, as it does live. */
  playbackIssues: new Map<string, Error>(),
}));

vi.mock('./media-cache', () => {
  const inspect = async (url: string, country: string, db: unknown) => ({
    metadata: await cachedLookup(url, country, db),
    playbackIssue: playbackIssues.get(url) ?? null,
  });
  // The real batch resolves in parallel and keeps failures; this mirrors that
  // over whatever the single-lookup stub is doing.
  const many = async <T,>(urls: string[], resolve: (url: string) => Promise<T>) => {
    const resolved = new Map<string, T | Error>();
    for (const url of urls) {
      try {
        resolved.set(url, await resolve(url));
      } catch (error) {
        resolved.set(url, error as Error);
      }
    }
    return resolved;
  };
  const lookup = async (url: string, country: string, db: unknown) => {
    const inspected = await inspect(url, country, db);
    if (inspected.playbackIssue) throw inspected.playbackIssue;
    return inspected.metadata;
  };
  return {
    inspectMediaCached: vi.fn(inspect),
    inspectManyCached: vi.fn((urls: string[], country: string, db: unknown) =>
      many(urls, (url) => inspect(url, country, db)),
    ),
    lookupMediaCached: vi.fn(lookup),
    lookupManyCached: vi.fn((urls: string[], country: string, db: unknown) =>
      many(urls, (url) => lookup(url, country, db)),
    ),
    // Only a cost saving live: the per-track lookups below answer the same
    // either way, so the stub does nothing.
    warmYouTubeLookups: vi.fn(async () => {}),
  };
});

vi.mock('./media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media')>()),
  listPlaylistTrackUrls: vi.fn(),
}));

const { listPlaylistTrackUrls, MediaLookupError } = await import('./media');
const schema = await import('./db/schema');
const {
  addPlaylistTrack,
  addPlaylistTrackByUrl,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  importQueupPlaylists,
  listPlaylists,
  queuePlaylist,
  queuePlaylistTrack,
  removePlaylistTrack,
  renamePlaylist,
  reorderPlaylist,
} = await import('./playlists');
const { enqueueMedia, getRoomSnapshot } = await import('./room');
const {
  media,
  moderationActions,
  playlistItems,
  playlists,
  queueItems,
  roomSettings,
  roomState,
  sessions,
  userChatCounts,
  users,
  votes,
} = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('personal playlists against Postgres', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(
      sql`truncate table ${playlistItems}, ${playlists}, ${moderationActions}, ${votes}, ${roomState}, ${roomSettings}, ${queueItems}, ${media}, ${sessions}, ${userChatCounts}, ${users} restart identity cascade`,
    );
    cachedLookup.mockReset();
    playbackIssues.clear();
    vi.mocked(listPlaylistTrackUrls).mockReset();
  });

  async function createUser(username: string): Promise<AuthenticatedUser> {
    const [created] = await db
      .insert(users)
      .values({
        dggUserId: `dgg-${username}`,
        username,
        dggStatus: 'active',
      })
      .returning({
        id: users.id,
        dggUserId: users.dggUserId,
        username: users.username,
        avatarUrl: users.avatarUrl,
        role: users.role,
        team: users.team,
        flair: users.flair,
        topEmote: users.topEmote,
        dggRoles: users.dggRoles,
        dggFeatures: users.dggFeatures,
      });
    if (!created) throw new Error('Could not create test user');
    return created;
  }

  async function createMedia(providerMediaId: string) {
    const [created] = await db
      .insert(media)
      .values({
        provider: 'youtube',
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${providerMediaId}`,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      })
      .returning({ id: media.id });
    if (!created) throw new Error('Could not create test media');
    return created;
  }

  it('creates a private playlist and saves an existing track', async () => {
    const owner = await createUser('owner');
    const saved = await createMedia('aaaaaaaaaaa');

    const playlistId = await createPlaylist('Driving', owner.id, db);
    await addPlaylistTrack(playlistId, saved.id, owner.id, db);

    const library = await listPlaylists(owner.id, [saved.id], db);
    expect(library.playlists).toMatchObject([
      { id: playlistId, name: 'Driving', trackCount: 1 },
    ]);
    expect(library.memberships).toEqual({ [saved.id]: [playlistId] });

    const playlist = await getPlaylist(playlistId, owner.id, db);
    expect(playlist.tracks.map(({ media }) => media.id)).toEqual([saved.id]);
  });

  it('rejects case-insensitive duplicate names for one owner', async () => {
    const owner = await createUser('owner');
    await createPlaylist('Driving', owner.id, db);

    await expect(createPlaylist('driving', owner.id, db)).rejects.toMatchObject({
      code: 'PLAYLIST_NAME_TAKEN',
    });
  });

  it('renames, reorders, and deletes an owned playlist', async () => {
    const owner = await createUser('owner');
    const first = await createMedia('aaaaaaaaaaa');
    const second = await createMedia('bbbbbbbbbbb');
    const playlistId = await createPlaylist('Driving', owner.id, db);
    await addPlaylistTrack(playlistId, first.id, owner.id, db);
    await addPlaylistTrack(playlistId, second.id, owner.id, db);

    await renamePlaylist(playlistId, 'Late night', owner.id, db);
    await reorderPlaylist(playlistId, [second.id, first.id], owner.id, db);

    const reordered = await getPlaylist(playlistId, owner.id, db);
    expect(reordered.name).toBe('Late night');
    expect(reordered.tracks.map(({ media }) => media.id)).toEqual([second.id, first.id]);

    await deletePlaylist(playlistId, owner.id, db);
    await expect(getPlaylist(playlistId, owner.id, db)).rejects.toMatchObject({
      code: 'PLAYLIST_NOT_FOUND',
    });
  });

  it('keeps another user out and removes membership idempotently', async () => {
    const owner = await createUser('owner');
    const intruder = await createUser('intruder');
    const saved = await createMedia('aaaaaaaaaaa');
    const playlistId = await createPlaylist('Private', owner.id, db);
    await addPlaylistTrack(playlistId, saved.id, owner.id, db);

    await expect(getPlaylist(playlistId, intruder.id, db)).rejects.toMatchObject({
      code: 'PLAYLIST_NOT_FOUND',
    });
    await expect(
      removePlaylistTrack(playlistId, saved.id, intruder.id, db),
    ).rejects.toMatchObject({ code: 'PLAYLIST_NOT_FOUND' });

    await removePlaylistTrack(playlistId, saved.id, owner.id, db);
    await removePlaylistTrack(playlistId, saved.id, owner.id, db);
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toEqual([]);
  });

  it('queues a saved track through the room policy without changing the playlist', async () => {
    const owner = await createUser('owner');
    const saved = await createMedia('aaaaaaaaaaa');
    const playlistId = await createPlaylist('Driving', owner.id, db);
    await addPlaylistTrack(playlistId, saved.id, owner.id, db);
    cachedLookup.mockResolvedValue({
      provider: 'youtube',
      providerMediaId: 'aaaaaaaaaaa',
      providerArtistId: 'channel-aaaaaaaaaaa',
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      title: 'Track aaaaaaaaaaa',
      artist: 'Test Artist',
      durationSeconds: 120,
      thumbnailUrl: null,
    });

    await queuePlaylistTrack(playlistId, saved.id, owner, db);

    expect((await getRoomSnapshot(owner, 1, db)).current?.media.id).toBe(saved.id);
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(1);
  });

  it('saves without room checks and applies current policy only when queueing', async () => {
    const owner = await createUser('owner');
    const saved = await createMedia('aaaaaaaaaaa');
    const playlistId = await createPlaylist('Driving', owner.id, db);

    await addPlaylistTrack(playlistId, saved.id, owner.id, db);
    expect(cachedLookup).not.toHaveBeenCalled();

    cachedLookup.mockResolvedValue({
      provider: 'youtube',
      providerMediaId: 'aaaaaaaaaaa',
      providerArtistId: 'channel-aaaaaaaaaaa',
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      title: 'Track aaaaaaaaaaa',
      artist: 'Test Artist',
      durationSeconds: 1_900,
      thumbnailUrl: null,
    });
    await expect(queuePlaylistTrack(playlistId, saved.id, owner, db)).rejects.toMatchObject({
      code: 'TRACK_TOO_LONG',
    });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(1);
  });

  it('saves a pasted link the room would refuse, and refuses it only at the queue', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Driving', owner.id, db);
    const url = 'https://www.youtube.com/watch?v=ccccccccccc';
    cachedLookup.mockResolvedValue({
      provider: 'youtube',
      providerMediaId: 'ccccccccccc',
      providerArtistId: 'channel-ccccccccccc',
      canonicalUrl: url,
      title: 'A long one',
      artist: 'Test Artist',
      durationSeconds: 1_900,
      thumbnailUrl: null,
    });

    expect(await addPlaylistTrackByUrl(playlistId, url, owner.id, db)).toEqual({
      attempted: 1,
      saved: 1,
      duplicates: 0,
      skipped: [],
    });

    const playlist = await getPlaylist(playlistId, owner.id, db);
    expect(playlist.tracks[0]!.media.title).toBe('A long one');
    const mediaId = playlist.tracks[0]!.media.id;

    await expect(queuePlaylistTrack(playlistId, mediaId, owner, db)).rejects.toMatchObject({
      code: 'TRACK_TOO_LONG',
    });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(1);
  });

  it('checks ownership before spending a provider lookup on a pasted link', async () => {
    const owner = await createUser('owner');
    const intruder = await createUser('intruder');
    const playlistId = await createPlaylist('Private', owner.id, db);

    await expect(
      addPlaylistTrackByUrl(playlistId, 'https://www.youtube.com/watch?v=ccccccccccc', intruder.id, db),
    ).rejects.toMatchObject({ code: 'PLAYLIST_NOT_FOUND' });
    expect(cachedLookup).not.toHaveBeenCalled();
  });

  it('saves the same link twice without duplicating it', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Driving', owner.id, db);
    const url = 'https://www.youtube.com/watch?v=ccccccccccc';
    cachedLookup.mockResolvedValue({
      provider: 'youtube',
      providerMediaId: 'ccccccccccc',
      providerArtistId: 'channel-ccccccccccc',
      canonicalUrl: url,
      title: 'A repeat',
      artist: 'Test Artist',
      durationSeconds: 120,
      thumbnailUrl: null,
    });

    await addPlaylistTrackByUrl(playlistId, url, owner.id, db);
    const again = await addPlaylistTrackByUrl(playlistId, `${url}&t=30s`, owner.id, db);

    expect(again).toEqual({ attempted: 1, saved: 0, duplicates: 1, skipped: [] });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(1);
  });

  it('saves a whole provider playlist and reports the tracks it could not read', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Imported', owner.id, db);
    const urls = ['ddddddddddd', 'eeeeeeeeeee', 'fffffffffff'].map(
      (id) => `https://www.youtube.com/watch?v=${id}`,
    );
    vi.mocked(listPlaylistTrackUrls).mockResolvedValue(urls);
    cachedLookup.mockImplementation(async (trackUrl: string) => {
      const providerMediaId = new URL(trackUrl).searchParams.get('v')!;
      if (providerMediaId === 'eeeeeeeeeee') {
        throw new MediaLookupError('YOUTUBE_NOT_FOUND', 'That YouTube video is unavailable.');
      }
      return {
        provider: 'youtube' as const,
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: trackUrl,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 2_000,
        thumbnailUrl: null,
      };
    });

    const result = await addPlaylistTrackByUrl(
      playlistId,
      'https://youtube.com/playlist?list=PL123&si=abc',
      owner.id,
      db,
    );

    // Every track is stored even though the room's duration limit would refuse
    // all of them: saving is not admission.
    expect(result).toMatchObject({ attempted: 3, saved: 2 });
    expect(result.skipped).toEqual([
      { title: urls[1], reason: 'That YouTube video is unavailable.' },
    ]);
    const playlist = await getPlaylist(playlistId, owner.id, db);
    expect(playlist.tracks.map(({ media }) => media.providerMediaId)).toEqual([
      'ddddddddddd',
      'fffffffffff',
    ]);
  });

  it('saves a track the playback host cannot reach and refuses it at the queue', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Driving', owner.id, db);
    const url = 'https://www.youtube.com/watch?v=ccccccccccc';
    cachedLookup.mockResolvedValue({
      provider: 'youtube',
      providerMediaId: 'ccccccccccc',
      providerArtistId: 'channel-ccccccccccc',
      canonicalUrl: url,
      title: 'Blocked where the host lives',
      artist: 'Test Artist',
      durationSeconds: 120,
      thumbnailUrl: null,
    });
    playbackIssues.set(
      url,
      new MediaLookupError(
        'YOUTUBE_REGION_BLOCKED',
        'That video is not available to the playback host in AE.',
      ),
    );

    expect(await addPlaylistTrackByUrl(playlistId, url, owner.id, db)).toEqual({
      attempted: 1,
      saved: 1,
      duplicates: 0,
      skipped: [],
    });

    const playlist = await getPlaylist(playlistId, owner.id, db);
    expect(playlist.tracks[0]!.media.title).toBe('Blocked where the host lives');
    await expect(
      queuePlaylistTrack(playlistId, playlist.tracks[0]!.media.id, owner, db),
    ).rejects.toMatchObject({ code: 'YOUTUBE_REGION_BLOCKED' });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(1);
  });

  it('saves the region-blocked tracks inside a provider playlist', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Imported', owner.id, db);
    const urls = ['ggggggggggg', 'hhhhhhhhhhh'].map(
      (id) => `https://www.youtube.com/watch?v=${id}`,
    );
    vi.mocked(listPlaylistTrackUrls).mockResolvedValue(urls);
    cachedLookup.mockImplementation(async (trackUrl: string) => {
      const providerMediaId = new URL(trackUrl).searchParams.get('v')!;
      return {
        provider: 'youtube' as const,
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: trackUrl,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      };
    });
    for (const url of urls) {
      playbackIssues.set(
        url,
        new MediaLookupError(
          'YOUTUBE_REGION_BLOCKED',
          'That video is not available to the playback host in AE.',
        ),
      );
    }

    const result = await addPlaylistTrackByUrl(
      playlistId,
      'https://youtube.com/playlist?list=PL123',
      owner.id,
      db,
    );

    expect(result).toEqual({ attempted: 2, saved: 2, duplicates: 0, skipped: [] });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(2);
  });

  it('counts a re-imported provider playlist as duplicates rather than saves', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Imported', owner.id, db);
    const urls = ['iiiiiiiiiii', 'jjjjjjjjjjj'].map(
      (id) => `https://www.youtube.com/watch?v=${id}`,
    );
    vi.mocked(listPlaylistTrackUrls).mockResolvedValue(urls);
    cachedLookup.mockImplementation(async (trackUrl: string) => {
      const providerMediaId = new URL(trackUrl).searchParams.get('v')!;
      return {
        provider: 'youtube' as const,
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: trackUrl,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      };
    });
    const listUrl = 'https://youtube.com/playlist?list=PL123';

    expect(await addPlaylistTrackByUrl(playlistId, listUrl, owner.id, db)).toEqual({
      attempted: 2,
      saved: 2,
      duplicates: 0,
      skipped: [],
    });
    expect(await addPlaylistTrackByUrl(playlistId, listUrl, owner.id, db)).toEqual({
      attempted: 2,
      saved: 0,
      duplicates: 2,
      skipped: [],
    });
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(2);
  });

  it('refuses a provider playlist with nothing playable in it', async () => {
    const owner = await createUser('owner');
    const playlistId = await createPlaylist('Imported', owner.id, db);
    vi.mocked(listPlaylistTrackUrls).mockResolvedValue([]);

    await expect(
      addPlaylistTrackByUrl(playlistId, 'https://youtube.com/playlist?list=PL123', owner.id, db),
    ).rejects.toMatchObject({ code: 'PLAYLIST_EMPTY' });
  });

  it('queues a whole playlist in order and reports policy failures', async () => {
    const owner = await createUser('owner');
    const duplicate = await createMedia('aaaaaaaaaaa');
    const eligible = await createMedia('bbbbbbbbbbb');
    const metadata = new Map([
      ['https://www.youtube.com/watch?v=aaaaaaaaaaa', {
        provider: 'youtube' as const,
        providerMediaId: 'aaaaaaaaaaa',
        providerArtistId: 'channel-aaaaaaaaaaa',
        canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        title: 'Track aaaaaaaaaaa',
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      }],
      ['https://www.youtube.com/watch?v=bbbbbbbbbbb', {
        provider: 'youtube' as const,
        providerMediaId: 'bbbbbbbbbbb',
        providerArtistId: 'channel-bbbbbbbbbbb',
        canonicalUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        title: 'Track bbbbbbbbbbb',
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      }],
    ]);
    cachedLookup.mockImplementation(async (url: string) => {
      const found = metadata.get(url);
      if (!found) throw new Error(`No metadata for ${url}`);
      return found;
    });
    await enqueueMedia(metadata.get('https://www.youtube.com/watch?v=aaaaaaaaaaa')!.canonicalUrl, owner, db);
    const playlistId = await createPlaylist('Driving', owner.id, db);
    await addPlaylistTrack(playlistId, duplicate.id, owner.id, db);
    await addPlaylistTrack(playlistId, eligible.id, owner.id, db);

    const result = await queuePlaylist(playlistId, owner, db);

    expect(result).toMatchObject({
      attempted: 2,
      added: 1,
      skipped: [{ mediaId: duplicate.id, code: 'ALREADY_QUEUED' }],
    });
    expect((await getRoomSnapshot(owner, 1, db)).myQueue.map(({ media }) => media.id)).toEqual([
      eligible.id,
    ]);
    expect((await getPlaylist(playlistId, owner.id, db)).tracks).toHaveLength(2);
  });

  describe('importing a library from QueUp', () => {
    /** Stands in for the provider: every id resolves to a track of that id. */
    function resolveEveryTrack(unavailableId?: string) {
      cachedLookup.mockImplementation(async (url: string) => {
        const id = new URL(url).searchParams.get('v') ?? 'unknown';
        if (id === unavailableId) {
          throw new MediaLookupError('YOUTUBE_NOT_FOUND', 'That YouTube video is unavailable.');
        }
        return {
          provider: 'youtube',
          providerMediaId: id,
          providerArtistId: `channel-${id}`,
          canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
          title: `Track ${id}`,
          artist: 'Test Artist',
          durationSeconds: 120,
          thumbnailUrl: null,
        };
      });
    }

    const file = (playlists: Array<{ name: string; ids: string[] }>) => ({
      source: 'queup' as const,
      kind: 'playlists' as const,
      playlists: playlists.map(({ name, ids }) => ({
        name,
        tracks: ids.map((id) => ({ provider: 'youtube', providerMediaId: id, title: `Track ${id}` })),
      })),
    });

    it('creates each playlist and saves its tracks', async () => {
      const owner = await createUser('owner');
      resolveEveryTrack();

      const result = await importQueupPlaylists(
        file([
          { name: 'Driving', ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'] },
          { name: 'Late night', ids: ['ccccccccccc'] },
        ]),
        owner.id,
        db,
      );

      expect(result.playlists).toMatchObject([
        { name: 'Driving', created: true, saved: 2, duplicates: 0, skipped: [] },
        { name: 'Late night', created: true, saved: 1 },
      ]);
      const library = await listPlaylists(owner.id, [], db);
      expect(library.playlists.map(({ name, trackCount }) => ({ name, trackCount }))).toEqual(
        expect.arrayContaining([
          { name: 'Driving', trackCount: 2 },
          { name: 'Late night', trackCount: 1 },
        ]),
      );
    });

    it('adds to a playlist of the same name instead of duplicating it', async () => {
      const owner = await createUser('owner');
      const existing = await createPlaylist('Driving', owner.id, db);
      const already = await createMedia('aaaaaaaaaaa');
      await addPlaylistTrack(existing, already.id, owner.id, db);
      resolveEveryTrack();

      const result = await importQueupPlaylists(
        file([{ name: 'driving', ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'] }]),
        owner.id,
        db,
      );

      expect(result.playlists[0]).toMatchObject({ created: false, saved: 1, duplicates: 1 });
      const playlist = await getPlaylist(existing, owner.id, db);
      expect(playlist.tracks).toHaveLength(2);
    });

    it('reports the tracks it could not read and keeps the rest', async () => {
      const owner = await createUser('owner');
      // Named rather than counted, because the tracks resolve in parallel and
      // the failing one is not reliably the first to ask.
      resolveEveryTrack('aaaaaaaaaaa');

      const result = await importQueupPlaylists(
        file([{ name: 'Driving', ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'] }]),
        owner.id,
        db,
      );

      expect(result.playlists[0]).toMatchObject({
        attempted: 2,
        saved: 1,
        skipped: [{ title: 'Track aaaaaaaaaaa', reason: 'That YouTube video is unavailable.' }],
      });
    });

    it('names a provider it cannot play rather than failing the import', async () => {
      const owner = await createUser('owner');
      resolveEveryTrack();

      const result = await importQueupPlaylists(
        {
          source: 'queup',
          kind: 'playlists',
          playlists: [
            {
              name: 'Driving',
              tracks: [
                { provider: 'bandcamp', providerMediaId: '12345', title: 'Something else' },
                { provider: 'youtube', providerMediaId: 'aaaaaaaaaaa', title: 'Track aaaaaaaaaaa' },
              ],
            },
          ],
        },
        owner.id,
        db,
      );

      expect(result.playlists[0]).toMatchObject({
        saved: 1,
        skipped: [{ title: 'Something else', reason: 'This room cannot play bandcamp tracks.' }],
      });
    });

    it('resolves a track shared by two playlists only once', async () => {
      const owner = await createUser('owner');
      resolveEveryTrack();

      await importQueupPlaylists(
        file([
          { name: 'Driving', ids: ['aaaaaaaaaaa'] },
          { name: 'Late night', ids: ['aaaaaaaaaaa'] },
        ]),
        owner.id,
        db,
      );

      expect(cachedLookup).toHaveBeenCalledTimes(1);
    });
  });
});
