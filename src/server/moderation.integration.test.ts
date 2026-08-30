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
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { getModerationLog } = await import('./moderation');
const schema = await import('./db/schema');
const { media, moderationActions, queueItems, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('the moderation log', () => {
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
      sql`truncate table ${moderationActions}, ${queueItems}, ${media}, ${users} restart identity cascade`,
    );
  });

  async function seed() {
    const [mod] = await db
      .insert(users)
      .values({ dggUserId: 'dgg-mod', username: 'a_mod', dggStatus: 'active', role: 'mod' })
      .returning({ id: users.id });
    const [listener] = await db
      .insert(users)
      .values({ dggUserId: 'dgg-listener', username: 'a_listener', dggStatus: 'active' })
      .returning({ id: users.id });
    const [track] = await db
      .insert(media)
      .values({
        provider: 'youtube',
        providerMediaId: 'aaaaaaaaaaa',
        providerArtistId: 'chan-a',
        canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        title: 'Track A',
        artist: 'An Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      })
      .returning({ id: media.id });
    if (!mod || !listener || !track) throw new Error('Could not seed the moderation log test');

    const [item] = await db
      .insert(queueItems)
      .values({ mediaId: track.id, requestedByUserId: listener.id, status: 'played' })
      .returning({ id: queueItems.id });
    if (!item) throw new Error('Could not seed the moderation log test');

    return { mod, listener, track, item };
  }

  it('reads a skip back with its actor, its track and its reason', async () => {
    const { mod, item } = await seed();
    await db.insert(moderationActions).values({
      actorUserId: mod.id,
      action: 'skip',
      queueItemId: item.id,
      details: { reason: 'off theme' },
    });

    const log = await getModerationLog(50, db);

    expect(log.entries).toMatchObject([
      {
        actor: 'a_mod',
        action: 'skip',
        track: { title: 'Track A', artist: 'An Artist' },
        reason: 'off theme',
        target: null,
      },
    ]);
  });

  // Blocking names the media directly rather than through a queue item.
  it('finds the track of a block that names no queue item', async () => {
    const { mod, track } = await seed();
    await db.insert(moderationActions).values({
      actorUserId: mod.id,
      action: 'block_artist',
      mediaId: track.id,
      details: { ruleIds: ['r1'], note: 'live sets only' },
    });

    const [entry] = (await getModerationLog(50, db)).entries;

    expect(entry?.track).toEqual({ title: 'Track A', artist: 'An Artist' });
    expect(entry?.reason).toBe('live sets only');
  });

  // The record stores an id, which is no use to read.
  it('names the person whose queue was cleared', async () => {
    const { mod, listener } = await seed();
    await db.insert(moderationActions).values({
      actorUserId: mod.id,
      action: 'clear_queue',
      details: { userId: listener.id, reason: 'spam', removed: 3 },
    });

    const [entry] = (await getModerationLog(50, db)).entries;

    expect(entry?.target).toBe('a_listener');
    expect(entry?.details).toMatchObject({ removed: 3 });
  });

  it('survives a record whose target is not a real id', async () => {
    const { mod } = await seed();
    await db.insert(moderationActions).values({
      actorUserId: mod.id,
      action: 'clear_queue',
      details: { userId: 'not-a-uuid', removed: 1 },
    });

    const [entry] = (await getModerationLog(50, db)).entries;

    expect(entry?.target).toBeNull();
    expect(entry?.action).toBe('clear_queue');
  });

  it('returns the newest action first, and no more than asked for', async () => {
    const { mod } = await seed();
    for (const action of ['skip', 'remove', 'update_settings']) {
      await db.insert(moderationActions).values({ actorUserId: mod.id, action, details: {} });
    }

    const log = await getModerationLog(2, db);

    expect(log.entries).toHaveLength(2);
    expect(log.entries[0]!.action).toBe('update_settings');
    expect(new Date(log.entries[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(log.entries[1]!.createdAt).getTime(),
    );
  });
});
