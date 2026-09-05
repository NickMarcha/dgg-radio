import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { getLegacyStats, listLegacyHistory } = await import('./legacy');
const schema = await import('./db/schema');
const { legacyPlays, media } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('the QueUp archive', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
    // Unlike the other tables here, this one is filled by a script rather than
    // by the room, so a test database somebody has imported into starts dirty.
    await db.execute(sql`truncate table ${legacyPlays}, ${media} restart identity cascade`);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${legacyPlays}, ${media} restart identity cascade`);
  });

  /** Plays a minute apart, oldest first, so the order under test is unambiguous. */
  async function archive(count: number, provider: 'youtube' | 'soundcloud' = 'youtube') {
    await db.insert(legacyPlays).values(
      Array.from({ length: count }, (_, index) => ({
        sourceId: `play-${index}`,
        playedAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
        requesterName: `queup-user-${index % 3}`,
        provider,
        providerMediaId: `video${index.toString().padStart(6, '0')}`,
        title: `Track ${index}`,
        durationSeconds: 200 + index,
        thumbnailUrl: null,
        upvotes: index,
        downvotes: 0,
        skipped: index === 0,
      })),
    );
  }

  it('reads newest first and says how much there is', async () => {
    await archive(5);

    const page = await listLegacyHistory({ limit: 3 }, db);

    expect(page.total).toBe(5);
    expect(page.entries.map((entry) => entry.title)).toEqual(['Track 4', 'Track 3', 'Track 2']);
    expect(page.entries[0]).toMatchObject({
      requesterName: 'queup-user-1',
      upvotes: 4,
      skipped: false,
      canonicalUrl: 'https://www.youtube.com/watch?v=video000004',
    });
  });

  it('reads the rest by page number without repeating a row', async () => {
    await archive(5);

    const first = await listLegacyHistory({ limit: 3 }, db);
    const second = await listLegacyHistory({ limit: 3, page: 2 }, db);

    expect(second.entries.map((entry) => entry.title)).toEqual(['Track 1', 'Track 0']);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(5);
  });

  it('leaves a SoundCloud track unlinked, because a numeric id is not a URL', async () => {
    await archive(1, 'soundcloud');

    const [entry] = (await listLegacyHistory({ limit: 10 }, db)).entries;

    expect(entry).toMatchObject({ provider: 'soundcloud', canonicalUrl: null });
  });

  it('counts the archive by track and by the QueUp name that requested it', async () => {
    await archive(5);

    const stats = await getLegacyStats(10, undefined, db);

    expect(stats.totals).toMatchObject({ plays: 5, tracks: 5, people: 3 });
    expect(stats.totals.since).toBe('2025-01-01T00:00:00.000Z');
    // Votes on QueUp were stored per play, so they are summed rather than counted.
    expect(stats.tracks[0]).toMatchObject({ plays: 1, upvotes: 4, score: 4 });
    // Three requesters, round-robin across five plays, so one of them has two.
    expect(stats.jammers.map((entry) => entry.plays).sort()).toEqual([1, 2, 2]);
  });

  it('reports an empty archive rather than failing on one', async () => {
    await expect(listLegacyHistory({ limit: 10 }, db)).resolves.toEqual({ entries: [], total: 0 });
  });

  it('searches the archive by title and by the QueUp name that requested it', async () => {
    await archive(5);

    const byTitle = await listLegacyHistory({ limit: 10, search: 'Track 3' }, db);
    const byRequester = await listLegacyHistory({ limit: 10, search: 'queup-user-1' }, db);

    expect(byTitle.entries.map((entry) => entry.title)).toEqual(['Track 3']);
    expect(byTitle.total).toBe(1);
    // Every third archived play, counting from the first.
    expect(byRequester.entries.map((entry) => entry.title)).toEqual(['Track 4', 'Track 1']);
  });

  it('names the room row an archived track already has, and leaves the rest null', async () => {
    await archive(2);
    await db.insert(media).values({
      provider: 'youtube',
      providerMediaId: 'video000001',
      providerArtistId: 'channel-1',
      canonicalUrl: 'https://www.youtube.com/watch?v=video000001',
      title: 'Track 1',
      artist: 'Test Artist',
      durationSeconds: 200,
    });

    const { entries } = await listLegacyHistory({ limit: 10 }, db);

    expect(entries.map((entry) => entry.mediaId === null)).toEqual([false, true]);
  });
});
