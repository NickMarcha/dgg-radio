import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaMetadata } from './media';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

vi.mock('./media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media')>()),
  inspectMedia: vi.fn(),
}));

const { inspectMedia, MediaLookupError } = await import('./media');
const { inspectMediaCached, lookupMediaCached } = await import('./media-cache');
const schema = await import('./db/schema');
const { mediaLookups } = schema;

const connectionString = testConnectionString();

const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const soundcloudUrl = 'https://soundcloud.com/artist/a-track';

function metadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    provider: 'youtube',
    providerMediaId: 'dQw4w9WgXcQ',
    providerArtistId: 'UC-channel',
    canonicalUrl: youtubeUrl,
    title: 'A Track',
    artist: 'An Artist',
    durationSeconds: 210,
    thumbnailUrl: null,
    ...overrides,
  };
}

/** The provider answered and the room can play it. */
function playable(overrides: Partial<MediaMetadata> = {}) {
  return { metadata: metadata(overrides), playbackIssue: null, regionRestriction: null };
}

const soundcloudMetadata = metadata({
  provider: 'soundcloud',
  providerMediaId: '123',
  canonicalUrl: soundcloudUrl,
});

describe.skipIf(!connectionString)('media lookup cache', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${mediaLookups}`);
    vi.mocked(inspectMedia).mockReset();
  });

  async function ageEntry(key: string, hoursAgo: number) {
    await db
      .update(mediaLookups)
      .set({ checkedAt: new Date(Date.now() - hoursAgo * 3_600_000) })
      .where(eq(mediaLookups.key, key));
  }

  it('asks the provider once and serves the stored answer after that', async () => {
    vi.mocked(inspectMedia).mockResolvedValue(playable());

    const first = await lookupMediaCached(youtubeUrl, 'AE', db);
    const second = await lookupMediaCached(youtubeUrl, 'AE', db);

    expect(first).toEqual(second);
    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  it('treats the same YouTube video as one entry across URL forms', async () => {
    vi.mocked(inspectMedia).mockResolvedValue(playable());

    await lookupMediaCached(youtubeUrl, 'AE', db);
    await lookupMediaCached('https://youtu.be/dQw4w9WgXcQ?t=42', 'AE', db);

    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  it('rechecks a YouTube entry after 24 hours and overwrites it in place', async () => {
    vi.mocked(inspectMedia).mockResolvedValueOnce(playable({ title: 'Old Title' }));
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 25);

    vi.mocked(inspectMedia).mockResolvedValueOnce(playable({ title: 'New Title' }));
    const rechecked = await lookupMediaCached(youtubeUrl, 'AE', db);

    expect(inspectMedia).toHaveBeenCalledTimes(2);
    expect(rechecked.title).toBe('New Title');

    const rows = await db.select().from(mediaLookups);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.title).toBe('New Title');
  });

  it('keeps a YouTube entry that is not yet a day old', async () => {
    vi.mocked(inspectMedia).mockResolvedValue(playable());
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 23);

    await lookupMediaCached(youtubeUrl, 'AE', db);
    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps a SoundCloud answer for a day and rechecks it after that', async () => {
    vi.mocked(inspectMedia).mockResolvedValue({
      metadata: soundcloudMetadata,
      playbackIssue: null,
      regionRestriction: null,
    });
    await lookupMediaCached(soundcloudUrl, 'AE', db);
    await ageEntry('soundcloud:soundcloud.com/artist/a-track', 23);

    await lookupMediaCached(soundcloudUrl, 'AE', db);
    expect(inspectMedia).toHaveBeenCalledTimes(1);

    await ageEntry('soundcloud:soundcloud.com/artist/a-track', 25);
    await lookupMediaCached(soundcloudUrl, 'AE', db);
    expect(inspectMedia).toHaveBeenCalledTimes(2);
  });

  it('leaves the stored answer alone when a recheck fails', async () => {
    vi.mocked(inspectMedia).mockResolvedValueOnce(playable({ title: 'Still Here' }));
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 25);

    vi.mocked(inspectMedia).mockRejectedValueOnce(new Error('the lookup failed'));
    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).rejects.toThrow('the lookup failed');

    const rows = await db.select().from(mediaLookups);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.title).toBe('Still Here');

    // Still expired, so the next attempt checks again rather than serving it.
    vi.mocked(inspectMedia).mockResolvedValueOnce(playable({ title: 'Back' }));
    expect((await lookupMediaCached(youtubeUrl, 'AE', db)).title).toBe('Back');
  });

  it('stores a refusal and answers from it, so one bad track is looked up once', async () => {
    vi.mocked(inspectMedia).mockResolvedValue({
      metadata: metadata(),
      playbackIssue: new MediaLookupError(
        'YOUTUBE_NOT_EMBEDDABLE',
        'That video cannot play in the radio player.',
      ),
      regionRestriction: null,
    });

    const inspected = await inspectMediaCached(youtubeUrl, 'AE', db);
    expect(inspected.metadata.title).toBe('A Track');
    expect(inspected.playbackIssue).toMatchObject({ code: 'YOUTUBE_NOT_EMBEDDABLE' });

    // The stored refusal still refuses, rather than letting a cache hit through.
    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).rejects.toMatchObject({
      code: 'YOUTUBE_NOT_EMBEDDABLE',
    });
    const second = await inspectMediaCached(youtubeUrl, 'AE', db);
    expect(second.playbackIssue).toMatchObject({ code: 'YOUTUBE_NOT_EMBEDDABLE' });
    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  it('rechecks a refusal after an hour, whichever provider gave it', async () => {
    vi.mocked(inspectMedia).mockResolvedValueOnce({
      metadata: soundcloudMetadata,
      playbackIssue: new MediaLookupError(
        'SOUNDCLOUD_NOT_STREAMABLE',
        'That SoundCloud track is not streamable.',
      ),
      regionRestriction: null,
    });
    await inspectMediaCached(soundcloudUrl, 'AE', db);
    await ageEntry('soundcloud:soundcloud.com/artist/a-track', 2);

    vi.mocked(inspectMedia).mockResolvedValueOnce({
      metadata: soundcloudMetadata,
      playbackIssue: null,
      regionRestriction: null,
    });
    const rechecked = await inspectMediaCached(soundcloudUrl, 'AE', db);

    expect(rechecked.playbackIssue).toBeNull();
    expect(inspectMedia).toHaveBeenCalledTimes(2);
  });

  // YouTube names the countries once, so one answer settles every region.
  it('answers a second playback region from the stored country lists', async () => {
    vi.mocked(inspectMedia).mockResolvedValue({
      metadata: metadata(),
      playbackIssue: null,
      regionRestriction: { blocked: ['US'] },
    });

    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).resolves.toMatchObject({
      title: 'A Track',
    });
    await expect(lookupMediaCached(youtubeUrl, 'US', db)).rejects.toMatchObject({
      code: 'YOUTUBE_REGION_BLOCKED',
    });
    await expect(lookupMediaCached(youtubeUrl, 'DE', db)).resolves.toMatchObject({
      title: 'A Track',
    });

    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  // A region refusal is not the video's own problem, so it keeps the ordinary
  // day-long life rather than the hour a real playback issue gets.
  it('keeps a region-blocked video cached for a day', async () => {
    vi.mocked(inspectMedia).mockResolvedValue({
      metadata: metadata(),
      playbackIssue: null,
      regionRestriction: { blocked: ['AE'] },
    });
    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).rejects.toMatchObject({
      code: 'YOUTUBE_REGION_BLOCKED',
    });
    await ageEntry('youtube:dQw4w9WgXcQ', 2);

    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).rejects.toMatchObject({
      code: 'YOUTUBE_REGION_BLOCKED',
    });
    expect(inspectMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects an unusable URL before touching the cache or the provider', async () => {
    await expect(lookupMediaCached('https://example.com/song', 'AE', db)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
    });
    expect(inspectMedia).not.toHaveBeenCalled();
  });
});
