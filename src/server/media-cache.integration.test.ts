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
  lookupMedia: vi.fn(),
}));

const { lookupMedia } = await import('./media');
const { lookupMediaCached } = await import('./media-cache');
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
    vi.mocked(lookupMedia).mockReset();
  });

  async function ageEntry(key: string, hoursAgo: number) {
    await db
      .update(mediaLookups)
      .set({ checkedAt: new Date(Date.now() - hoursAgo * 3_600_000) })
      .where(eq(mediaLookups.key, key));
  }

  it('asks the provider once and serves the stored answer after that', async () => {
    vi.mocked(lookupMedia).mockResolvedValue(metadata());

    const first = await lookupMediaCached(youtubeUrl, 'AE', db);
    const second = await lookupMediaCached(youtubeUrl, 'AE', db);

    expect(first).toEqual(second);
    expect(lookupMedia).toHaveBeenCalledTimes(1);
  });

  it('treats the same YouTube video as one entry across URL forms', async () => {
    vi.mocked(lookupMedia).mockResolvedValue(metadata());

    await lookupMediaCached(youtubeUrl, 'AE', db);
    await lookupMediaCached('https://youtu.be/dQw4w9WgXcQ?t=42', 'AE', db);

    expect(lookupMedia).toHaveBeenCalledTimes(1);
  });

  it('rechecks a YouTube entry after 24 hours and overwrites it in place', async () => {
    vi.mocked(lookupMedia).mockResolvedValueOnce(metadata({ title: 'Old Title' }));
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 25);

    vi.mocked(lookupMedia).mockResolvedValueOnce(metadata({ title: 'New Title' }));
    const rechecked = await lookupMediaCached(youtubeUrl, 'AE', db);

    expect(lookupMedia).toHaveBeenCalledTimes(2);
    expect(rechecked.title).toBe('New Title');

    const rows = await db.select().from(mediaLookups);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.title).toBe('New Title');
  });

  it('keeps a YouTube entry that is not yet a day old', async () => {
    vi.mocked(lookupMedia).mockResolvedValue(metadata());
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 23);

    await lookupMediaCached(youtubeUrl, 'AE', db);
    expect(lookupMedia).toHaveBeenCalledTimes(1);
  });

  it('never re-runs a paid SoundCloud lookup, however old', async () => {
    vi.mocked(lookupMedia).mockResolvedValue(soundcloudMetadata);
    await lookupMediaCached(soundcloudUrl, 'AE', db);
    await ageEntry('soundcloud:soundcloud.com/artist/a-track', 24 * 365);

    await lookupMediaCached(soundcloudUrl, 'AE', db);
    expect(lookupMedia).toHaveBeenCalledTimes(1);
  });

  it('leaves the stored answer alone when a recheck fails', async () => {
    vi.mocked(lookupMedia).mockResolvedValueOnce(metadata({ title: 'Still Here' }));
    await lookupMediaCached(youtubeUrl, 'AE', db);
    await ageEntry('youtube:dQw4w9WgXcQ', 25);

    vi.mocked(lookupMedia).mockRejectedValueOnce(new Error('now blocked in AE'));
    await expect(lookupMediaCached(youtubeUrl, 'AE', db)).rejects.toThrow('now blocked in AE');

    const rows = await db.select().from(mediaLookups);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.title).toBe('Still Here');

    // Still expired, so the next attempt checks again rather than serving it.
    vi.mocked(lookupMedia).mockResolvedValueOnce(metadata({ title: 'Back' }));
    expect((await lookupMediaCached(youtubeUrl, 'AE', db)).title).toBe('Back');
  });

  it('rejects an unusable URL before touching the cache or the provider', async () => {
    await expect(lookupMediaCached('https://example.com/song', 'AE', db)).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
    });
    expect(lookupMedia).not.toHaveBeenCalled();
  });
});
