import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { getCommunityStats, getUserProfile, listHistory } = await import('./community');
const schema = await import('./db/schema');
const { media, queueItems, users, votes, userChatCounts } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('community profiles, stats, and history', () => {
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
      sql`truncate table ${userChatCounts}, ${votes}, ${queueItems}, ${media}, ${users} restart identity cascade`,
    );
  });

  async function createUser(username: string, team: 'pepe' | 'yee' | null = null) {
    const [user] = await db
      .insert(users)
      .values({
        dggUserId: `dgg-${username}`,
        username,
        team,
        dggStatus: 'active',
      })
      .returning({ id: users.id });
    if (!user) throw new Error('Could not create user');
    return user.id;
  }

  async function createTrack(
    providerMediaId: string,
    requesterId: string,
    status: 'queued' | 'played' | 'skipped',
    startedAt: Date | null,
    finishedAt: Date | null,
  ) {
    const [track] = await db
      .insert(media)
      .values({
        provider: 'youtube',
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${providerMediaId}`,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 180,
      })
      .returning({ id: media.id });
    if (!track) throw new Error('Could not create media');

    const [item] = await db
      .insert(queueItems)
      .values({
        mediaId: track.id,
        requestedByUserId: requesterId,
        status,
        startedAt,
        finishedAt,
      })
      .returning({ id: queueItems.id });
    if (!item) throw new Error('Could not create queue item');
    return item.id;
  }

  /** Queues and plays an existing track again, so one media row has several plays. */
  async function replay(providerMediaId: string, requesterId: string, startedAt: Date) {
    const [track] = await db
      .select({ id: media.id })
      .from(media)
      .where(eq(media.providerMediaId, providerMediaId));
    if (!track) throw new Error('Could not find media');
    await db.insert(queueItems).values({
      mediaId: track.id,
      requestedByUserId: requesterId,
      status: 'played',
      startedAt,
      finishedAt: startedAt,
    });
  }

  async function seedCommunity() {
    const alice = await createUser('Alice', 'pepe');
    const bob = await createUser('Bob', 'yee');
    const quiet = await createUser('Quiet');
    const oldest = new Date('2026-08-27T11:00:00.000Z');
    const older = new Date('2026-08-27T12:00:00.000Z');
    const newer = new Date('2026-08-28T12:00:00.000Z');

    const alicePlayed = await createTrack('aaaaaaaaaaa', alice, 'played', older, older);
    const aliceSkipped = await createTrack('bbbbbbbbbbb', alice, 'skipped', newer, newer);
    const bobPlayed = await createTrack('ccccccccccc', bob, 'played', oldest, oldest);
    await createTrack('ddddddddddd', quiet, 'queued', null, null);

    await db.insert(votes).values([
      { queueItemId: alicePlayed, userId: bob, value: 1 },
      { queueItemId: alicePlayed, userId: quiet, value: 1 },
      { queueItemId: aliceSkipped, userId: bob, value: -1 },
      { queueItemId: bobPlayed, userId: alice, value: 1 },
    ]);

    return { alice, alicePlayed, aliceSkipped, bobPlayed };
  }

  it('builds a case-insensitive profile with per-play averages and recent plays', async () => {
    await seedCommunity();

    const profile = await getUserProfile('alice', null, db);

    expect(profile.user).toMatchObject({ username: 'Alice', team: 'pepe' });
    expect(profile.stats).toEqual({
      requests: 2,
      plays: 2,
      played: 1,
      skipped: 1,
      upvotes: 2,
      downvotes: 1,
      score: 1,
      averageVotesPerPlay: 1.5,
      averageScorePerPlay: 0.5,
    });
    expect(profile.history.map((item) => item.status)).toEqual(['skipped', 'played']);
    expect(profile.history[0]).toMatchObject({ upvotes: 0, downvotes: 1 });
  });

  it('ranks tracks by plays, then by score, and ignores ones that never started', async () => {
    const { alice } = await seedCommunity();
    await replay('ccccccccccc', alice, new Date('2026-08-28T13:00:00.000Z'));

    const { tracks } = await getCommunityStats(db);

    expect(tracks.map(({ media: track, plays, score }) => [track.providerMediaId, plays, score])).toEqual([
      ['ccccccccccc', 2, 1],
      ['aaaaaaaaaaa', 1, 2],
      ['bbbbbbbbbbb', 1, -1],
    ]);
  });

  it('orders completed room history newest first and excludes queued requests', async () => {
    const { alicePlayed, aliceSkipped, bobPlayed } = await seedCommunity();

    const page = await listHistory({}, db);

    expect(page.entries.map((item) => item.id)).toEqual([aliceSkipped, alicePlayed, bobPlayed]);
    expect(page.total).toBe(3);
    expect(page.entries.every((item) => item.startedAt && item.finishedAt)).toBe(true);
    expect(page.entries[0]).toMatchObject({ status: 'skipped', upvotes: 0, downvotes: 1 });
  });

  it('numbers the pages, and counts every match rather than the page', async () => {
    const { alicePlayed, aliceSkipped, bobPlayed } = await seedCommunity();

    const first = await listHistory({ limit: 2 }, db);
    const second = await listHistory({ limit: 2, page: 2 }, db);
    const past = await listHistory({ limit: 2, page: 9 }, db);

    expect(first.entries.map((item) => item.id)).toEqual([aliceSkipped, alicePlayed]);
    expect(second.entries.map((item) => item.id)).toEqual([bobPlayed]);
    // The count is of everything the request matched, so a page can say how
    // many there are without reading them.
    expect([first.total, second.total]).toEqual([3, 3]);
    expect(past.entries).toEqual([]);
  });

  it('searches the room history by track and by who requested it', async () => {
    const { alicePlayed, aliceSkipped } = await seedCommunity();

    const byTitle = await listHistory({ search: 'bbbbbbbbbbb' }, db);
    const byRequester = await listHistory({ search: 'alice' }, db);
    const byNothing = await listHistory({ search: 'nothing matches this' }, db);

    expect(byTitle.entries.map((item) => item.id)).toEqual([aliceSkipped]);
    expect(byTitle.total).toBe(1);
    expect(byRequester.entries.map((item) => item.id)).toEqual([aliceSkipped, alicePlayed]);
    expect(byNothing).toEqual({ entries: [], total: 0 });
  });

  it('treats a LIKE wildcard in a search as the character somebody typed', async () => {
    await seedCommunity();

    // Unescaped, `_` would match any character and find all three tracks.
    await expect(listHistory({ search: 'Track _' }, db)).resolves.toMatchObject({ total: 0 });
  });

  it('narrows every table to a year or a month, and says what it could offer', async () => {
    const { alicePlayed, aliceSkipped, bobPlayed } = await seedCommunity();

    const everything = await getCommunityStats(db);
    // The seed plays on 2026-08-27 and 2026-08-28.
    const august = await getCommunityStats(db, { year: 2026, month: 8 });
    const july = await getCommunityStats(db, { year: 2026, month: 7 });
    const wrongYear = await getCommunityStats(db, { year: 2025, month: null });

    expect(everything.totals.tracksPlayed).toBe(3);
    expect(august.totals.tracksPlayed).toBe(3);
    expect(august.tracks.map(({ media: track }) => track.providerMediaId).sort()).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(july.tracks).toEqual([]);
    expect(july.totals.tracksPlayed).toBe(0);
    expect(wrongYear.jammers.every((entry) => entry.plays === 0)).toBe(true);

    // What the filter can offer ignores what the filter is currently set to.
    expect(july.periods).toEqual([{ year: 2026, months: [8] }]);
    expect([alicePlayed, aliceSkipped, bobPlayed].every(Boolean)).toBe(true);
  });

  it('ranks jammers and keeps users without a detected team visible', async () => {
    await seedCommunity();

    const stats = await getCommunityStats(db);

    expect(stats.totals).toEqual({ members: 3, tracksPlayed: 3, votes: 4 });
    expect(stats.jammers.map((entry) => [entry.user.username, entry.score, entry.plays])).toEqual([
      ['Alice', 1, 2],
      ['Bob', 1, 1],
    ]);
    expect(stats.teams).toEqual([
      { team: 'pepe', members: 1, plays: 2, upvotes: 2, downvotes: 1, score: 1 },
      { team: 'yee', members: 1, plays: 1, upvotes: 1, downvotes: 0, score: 1 },
      { team: 'unassigned', members: 1, plays: 0, upvotes: 0, downvotes: 0, score: 0 },
    ]);
  });

  it('returns a clear 404 error for an unknown username', async () => {
    await expect(getUserProfile('missing', null, db)).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      status: 404,
    });
  });
});
