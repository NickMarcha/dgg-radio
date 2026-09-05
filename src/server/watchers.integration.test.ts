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

  const tracked = (channel: string, chatCount: number, siteCount: number | null = null) => ({
    channel: { platform: 'kick' as const, id: channel },
    live: siteCount !== null,
    siteCount,
    chatCount,
    watchers: [],
  });

  const listed = (platform: string, id: string, count: number) => ({
    platform,
    id,
    count,
    displayName: null,
    title: null,
    previewUrl: null,
    viewers: null,
  });

  it('keeps one latest sample per minute and target', async () => {
    await recordStreamWatchSample(
      [listed('kick', 'destiny', 840)],
      tracked('destiny', 851, 840),
      new Date('2026-09-05T20:14:05.000Z'),
      db,
    );
    await recordStreamWatchSample(
      [listed('kick', 'destiny', 845)],
      tracked('destiny', 856, 845),
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
    });
  });

  it('records every embed the site listed, not only the one being followed', async () => {
    await recordStreamWatchSample(
      [listed('kick', 'destiny', 840), listed('kick', 'Zugami', 56), listed('youtube', 'abc123', 16)],
      tracked('destiny', 851, 840),
      new Date('2026-09-05T20:14:05.000Z'),
      db,
    );

    const rows = await db.select().from(streamWatchSamples);
    expect(rows.map((row) => `${row.platform}/${row.channel}`).sort()).toEqual([
      'kick/destiny',
      'kick/zugami',
      'youtube/abc123',
    ]);
    // Only the followed channel has a roster behind it.
    expect(rows.filter((row) => row.chatCount !== null)).toHaveLength(1);
  });

  it('records the followed channel in a minute the site did not list it', async () => {
    await recordStreamWatchSample(
      [listed('kick', 'someoneelse', 12)],
      tracked('dggjams', 3),
      new Date('2026-09-05T20:14:05.000Z'),
      db,
    );

    const [row] = await db
      .select()
      .from(streamWatchSamples)
      .where(sql`channel = 'dggjams'`);
    expect(row).toMatchObject({ siteCount: null, chatCount: 3 });
  });

  it('does not overwrite another target selected in the same minute', async () => {
    const at = new Date('2026-09-05T20:14:30.000Z');
    await recordStreamWatchSample([listed('kick', 'destiny', 840)], tracked('destiny', 851, 840), at, db);
    await recordStreamWatchSample(
      [],
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

  it('groups a longer period into coarser points', async () => {
    // A week of minutes is 10,080 points per channel, and there are as many
    // channels as the site is listing. Longer periods are grouped instead.
    const at = (minute: string) => new Date(`2026-09-05T${minute}:00.000Z`);
    await recordStreamWatchSample([listed('kick', 'destiny', 10)], tracked('destiny', 11, 10), at('12:01'), db);
    await recordStreamWatchSample([listed('kick', 'destiny', 30)], tracked('destiny', 31, 30), at('12:03'), db);

    const history = await getStreamWatchHistory(at('00:00'), at('20:00'), db);

    expect(history.bucketMinutes).toBe(5);
    expect(history.samples).toHaveLength(1);
    // The busiest reading in the bucket, not the last one: a peak that lasted a
    // minute is the thing worth seeing at this width.
    expect(history.samples[0]).toMatchObject({ siteCount: 30, chatCount: 31 });
  });

  it('draws the busiest channels, and always the one being followed', async () => {
    const at = new Date('2026-09-05T12:00:00.000Z');
    const crowd = Array.from({ length: 12 }, (_, index) =>
      listed('kick', `channel${index}`, 100 + index),
    );
    // The followed channel is the quietest thing on the list.
    await recordStreamWatchSample([...crowd, listed('kick', 'dggjams', 2)], tracked('dggjams', 3, 2), at, db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T11:00:00.000Z'),
      new Date('2026-09-05T13:00:00.000Z'),
      db,
    );

    const drawn = history.samples.map((sample) => sample.channel);
    expect(drawn).toHaveLength(8);
    expect(drawn).toContain('dggjams');
    expect(drawn).toContain('channel11');
    expect(drawn).not.toContain('channel0');
  });

  it('returns only samples inside the requested period', async () => {
    const snapshot = tracked('destiny', 851, 840);
    const entries = [listed('kick', 'destiny', 840)];
    await recordStreamWatchSample(entries, snapshot, new Date('2026-09-05T18:59:00.000Z'), db);
    await recordStreamWatchSample(entries, snapshot, new Date('2026-09-05T19:00:00.000Z'), db);
    await recordStreamWatchSample(entries, snapshot, new Date('2026-09-05T20:00:00.000Z'), db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T19:00:00.000Z'),
      new Date('2026-09-05T19:30:00.000Z'),
      db,
    );
    expect(history).toEqual({
      from: '2026-09-05T19:00:00.000Z',
      to: '2026-09-05T19:30:00.000Z',
      bucketMinutes: 1,
      other: [],
      otherChannels: 0,
      samples: [
        {
          sampledAt: '2026-09-05T19:00:00.000Z',
          platform: 'kick',
          channel: 'destiny',
          siteCount: 840,
          chatCount: 851,
        },
      ],
    });
  });
});
