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

const {
  getStreamWatchHistory,
  getStreamWatchSettings,
  recordStreamWatchSample,
  updateStreamWatchSettings,
  watchTracker,
} = await import('./watchers');
const schema = await import('./db/schema');
const { streamWatch, streamWatchSamples, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('stream watch settings', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    // Nothing ever connected: the settings start disabled and every case here
    // leaves them that way.
    watchTracker.stop();
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${streamWatchSamples}, ${streamWatch}, ${users} cascade`);
  });

  async function createAdmin() {
    const [row] = await db
      .insert(users)
      .values({
        dggUserId: 'dgg-picklesnathan',
        username: 'picklesnathan',
        role: 'admin',
        dggStatus: 'Active',
      })
      .returning({ id: users.id });
    return row!.id;
  }

  it('starts switched off, so nothing connects until an admin asks for it', async () => {
    const settings = await getStreamWatchSettings(db);
    expect(settings).toMatchObject({ enabled: false, platform: 'kick', channel: '' });
  });

  it('stores the channel lowercase, however an admin types it', async () => {
    const userId = await createAdmin();
    // The bigscreen link is written #kick/dggJams; chat reports it lowercase.
    const settings = await updateStreamWatchSettings({ channel: '  dggJams ' }, userId, db);
    expect(settings.channel).toBe('dggjams');
  });

  it('keeps the settings it was not asked to change', async () => {
    const userId = await createAdmin();
    await updateStreamWatchSettings({ platform: 'twitch', channel: 'someone' }, userId, db);
    const settings = await updateStreamWatchSettings({ enabled: true }, userId, db);
    expect(settings).toMatchObject({ enabled: true, platform: 'twitch', channel: 'someone' });
  });

  it('records who changed it', async () => {
    const userId = await createAdmin();
    await updateStreamWatchSettings({ enabled: false }, userId, db);
    const [row] = await db.select().from(streamWatch);
    expect(row.updatedByUserId).toBe(userId);
  });

  it('reports no channel while nothing is being watched', () => {
    expect(watchTracker.snapshot()).toMatchObject({
      channel: null,
      live: false,
      siteCount: null,
      chatCount: 0,
      watchers: [],
    });
  });

  it('keeps one latest sample per minute and target', async () => {
    const first = {
      channel: { platform: 'kick' as const, id: 'destiny' },
      live: true,
      siteCount: 840,
      chatCount: 851,
      watchers: [],
    };
    await recordStreamWatchSample(first, new Date('2026-09-05T20:14:05.000Z'), db);
    await recordStreamWatchSample(
      { ...first, siteCount: 845, chatCount: 856 },
      new Date('2026-09-05T20:14:54.000Z'),
      db,
    );

    const rows = await db.select().from(streamWatchSamples);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sampledAt: new Date('2026-09-05T20:14:00.000Z'),
      platform: 'kick',
      channel: 'destiny',
      siteCount: 845,
      chatCount: 856,
      live: true,
    });
  });

  it('does not overwrite another target selected in the same minute', async () => {
    const at = new Date('2026-09-05T20:14:30.000Z');
    await recordStreamWatchSample(
      {
        channel: { platform: 'kick', id: 'destiny' },
        live: true,
        siteCount: 840,
        chatCount: 851,
        watchers: [],
      },
      at,
      db,
    );
    await recordStreamWatchSample(
      {
        channel: { platform: 'youtube', id: 'another-channel' },
        live: false,
        siteCount: null,
        chatCount: 0,
        watchers: [],
      },
      at,
      db,
    );

    const rows = await db.select().from(streamWatchSamples);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.platform}/${row.channel}`).sort()).toEqual([
      'kick/destiny',
      'youtube/another-channel',
    ]);
  });

  it('returns only samples inside the requested period', async () => {
    const snapshot = {
      channel: { platform: 'kick' as const, id: 'destiny' },
      live: true,
      siteCount: 840,
      chatCount: 851,
      watchers: [],
    };
    await recordStreamWatchSample(snapshot, new Date('2026-09-05T18:59:00.000Z'), db);
    await recordStreamWatchSample(snapshot, new Date('2026-09-05T19:00:00.000Z'), db);
    await recordStreamWatchSample(snapshot, new Date('2026-09-05T20:00:00.000Z'), db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T19:00:00.000Z'),
      new Date('2026-09-05T19:30:00.000Z'),
      db,
    );
    expect(history).toEqual({
      from: '2026-09-05T19:00:00.000Z',
      to: '2026-09-05T19:30:00.000Z',
      samples: [
        {
          sampledAt: '2026-09-05T19:00:00.000Z',
          platform: 'kick',
          channel: 'destiny',
          siteCount: 840,
          chatCount: 851,
          live: true,
        },
      ],
    });
  });
});
