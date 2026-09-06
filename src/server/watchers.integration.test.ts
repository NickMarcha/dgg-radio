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
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const {
  bucketMinutesFor,
  DETAIL_DAYS,
  downsampleStreamWatchSamples,
  getStreamWatchHistory,
  getStreamWatchSettings,
  intervalStart,
  listStreamWatchChannels,
  SampleAverage,
  SAMPLE_MINUTES,
  recordStreamWatchSample,
  updateStreamWatchSettings,
  watchTracker,
} = await import('./watchers');
const schema = await import('./db/schema');
const { streamWatch, streamWatchChannels, streamWatchSamples, users } = schema;

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
    await db.execute(
      sql`truncate table ${streamWatchSamples}, ${streamWatchChannels}, ${streamWatch}, ${users} cascade`,
    );
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

  /**
   * The stored rows with their channel named again. The samples themselves hold
   * an id, which is the point of the table, and is not what a test is about.
   */
  const storedRows = () =>
    db
      .select({
        sampledAt: streamWatchSamples.sampledAt,
        platform: streamWatchChannels.platform,
        channel: streamWatchChannels.channel,
        siteCount: streamWatchSamples.siteCount,
      })
      .from(streamWatchSamples)
      .innerJoin(streamWatchChannels, eq(streamWatchChannels.id, streamWatchSamples.channelId));

  /** One reading, stored as the average of an interval containing just it. */
  const sampleOnce = (
    entries: Parameters<InstanceType<typeof SampleAverage>['add']>[0],
    at: Date,
    database = db,
  ) => {
    const average = new SampleAverage(intervalStart(at));
    average.add(entries);
    return recordStreamWatchSample(average, database);
  };

  const listed = (platform: string, id: string, count: number) => ({
    platform,
    id,
    count,
    displayName: null,
    title: null,
    previewUrl: null,
    viewers: null,
  });

  it('keeps one latest sample per interval and target', async () => {
    // Two readings thirteen minutes apart. They were two rows when a row was
    // kept per minute; they are one quarter-hour now, and the later one wins.
    await sampleOnce(
      [listed('kick', 'destiny', 840)],
      new Date('2026-09-05T20:01:05.000Z'),
      db,
    );
    await sampleOnce(
      [listed('kick', 'destiny', 845)],
      new Date('2026-09-05T20:14:54.000Z'),
      db,
    );

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sampledAt: new Date('2026-09-05T20:00:00.000Z'),
      platform: 'kick',
      channel: 'destiny',
      siteCount: 845,
    });
  });

  it('starts a new row at the next interval', async () => {
    await sampleOnce(
      [listed('kick', 'destiny', 840)],
      new Date('2026-09-05T20:14:54.000Z'),
      db,
    );
    await sampleOnce(
      [listed('kick', 'destiny', 845)],
      new Date('2026-09-05T20:15:01.000Z'),
      db,
    );

    const rows = await storedRows();
    expect(rows.map((row) => row.sampledAt.toISOString()).sort()).toEqual([
      '2026-09-05T20:00:00.000Z',
      '2026-09-05T20:15:00.000Z',
    ]);
  });

  it('records the site whatever the follow switch says', async () => {
    // The switch names the channel whose chat roster the overlay draws. It is
    // not a switch on the recording: the live socket is the room's own record
    // of what destiny.gg was watching, and a minute of that cannot be had
    // afterwards. This is never told which channel is followed at all.
    await sampleOnce(
      [listed('kick', 'destiny', 840), listed('youtube', 'someone', 3)],
      new Date('2026-09-05T20:14:00.000Z'),
      db,
    );

    const rows = await storedRows();
    expect(rows.map((row) => `${row.platform}/${row.channel}`).sort()).toEqual([
      'kick/destiny',
      'youtube/someone',
    ]);
  });

  it('records every embed the site listed, each of them the same way', async () => {
    await sampleOnce(
      [listed('kick', 'destiny', 840), listed('kick', 'Zugami', 56), listed('youtube', 'abc123', 16)],
      new Date('2026-09-05T20:14:05.000Z'),
      db,
    );

    const rows = await storedRows();
    expect(rows.map((row) => `${row.platform}/${row.channel}`).sort()).toEqual([
      'kick/destiny',
      'kick/zugami',
      'youtube/abc123',
    ]);
    // One number per row, and every row has it: a stored sample is an embed the
    // site listed, so there is no such thing as a row that measured nothing.
    expect(rows.every((row) => typeof row.siteCount === 'number')).toBe(true);
  });

  it('stores nothing at all for a minute the site listed nothing', async () => {
    // A minute with no row is exactly what a break in the graph is drawn from,
    // so an empty list is recorded by recording nothing.
    await sampleOnce([], new Date('2026-09-05T20:14:05.000Z'), db);

    expect(await storedRows()).toHaveLength(0);
  });

  it('stores the mean of an interval rather than its last reading', async () => {
    // Every minute of the quarter hour is read; what is kept is the average of
    // them, so a point on the chart describes the quarter hour rather than the
    // instant the timer happened to fire.
    const average = new SampleAverage(new Date('2026-09-05T20:00:00.000Z'));
    average.add([listed('kick', 'destiny', 100)]);
    average.add([listed('kick', 'destiny', 200)]);
    average.add([listed('kick', 'destiny', 300)]);
    await recordStreamWatchSample(average, db);

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sampledAt: new Date('2026-09-05T20:00:00.000Z'),
      channel: 'destiny',
      siteCount: 200,
    });
  });

  it('counts a reading a channel is missing from as nobody watching it', async () => {
    // The site lists an embed only while somebody has it open, so a channel
    // absent from a reading is a measurement rather than a missing one. What it
    // must not do is divide by the readings the channel appeared in, which
    // would report a one-minute crowd as if it had stayed all quarter hour.
    const average = new SampleAverage(new Date('2026-09-05T20:00:00.000Z'));
    average.add([listed('kick', 'destiny', 400), listed('kick', 'steady', 10)]);
    average.add([listed('kick', 'steady', 10)]);
    average.add([listed('kick', 'steady', 10)]);
    average.add([listed('kick', 'steady', 10)]);
    await recordStreamWatchSample(average, db);

    const rows = await storedRows();
    const counts = Object.fromEntries(rows.map((row) => [row.channel, row.siteCount]));
    expect(counts).toEqual({ destiny: 100, steady: 10 });
  });

  it('writes nothing for an interval in which the list was never read', async () => {
    await recordStreamWatchSample(new SampleAverage(new Date('2026-09-05T20:00:00.000Z')), db);

    expect(await storedRows()).toHaveLength(0);
  });

  it('rolls readings past the detail window down to one an hour', async () => {
    // A quarter of an hour is worth keeping while somebody might look at it
    // closely. Past the window nothing can draw it at finer than two hours
    // anyway, so four readings become their average and the table stops growing
    // four times faster than it needs to.
    const now = new Date('2026-09-05T00:00:00.000Z');
    const old = new Date(now.getTime() - (DETAIL_DAYS + 1) * 24 * 3_600_000);
    for (const [minutes, count] of [
      [0, 100],
      [15, 200],
      [30, 300],
      [45, 400],
    ] as const) {
      await sampleOnce(
        [listed('kick', 'destiny', count)],
        new Date(old.getTime() + minutes * 60_000),
        db,
      );
    }
    // And one inside the window, which must be left exactly as it is.
    await sampleOnce([listed('kick', 'destiny', 7)], now, db);

    const removed = await downsampleStreamWatchSamples(now, db);
    expect(removed).toBe(3);

    const rows = (await storedRows()).sort((left, right) =>
      left.sampledAt.getTime() - right.sampledAt.getTime(),
    );
    expect(rows).toHaveLength(2);
    // The hour holds the mean of the four quarters it replaced.
    expect(rows[0]).toMatchObject({ sampledAt: old, siteCount: 250 });
    expect(rows[1]).toMatchObject({ sampledAt: now, siteCount: 7 });
  });

  it('can be rolled twice without changing what it rolled', async () => {
    // It runs on a timer and at every startup, so it has to be safe to repeat.
    // The second pass groups each hourly row on its own, which is itself.
    const now = new Date('2026-09-05T00:00:00.000Z');
    const old = new Date(now.getTime() - (DETAIL_DAYS + 1) * 24 * 3_600_000);
    await sampleOnce([listed('kick', 'destiny', 100)], old, db);
    await sampleOnce([listed('kick', 'destiny', 300)], new Date(old.getTime() + 30 * 60_000), db);

    await downsampleStreamWatchSamples(now, db);
    const once = await storedRows();
    expect(await downsampleStreamWatchSamples(now, db)).toBe(0);

    expect(await storedRows()).toEqual(once);
    expect(once[0]).toMatchObject({ siteCount: 200 });
  });

  it('never buckets a chart more finely than it samples', () => {
    // A bucket narrower than the interval cannot hold two readings, so it would
    // draw the same points further apart and call it more detail.
    const at = (iso: string) => new Date(iso);
    expect(bucketMinutesFor(at('2026-09-05T12:00:00Z'), at('2026-09-05T13:00:00Z'))).toBe(
      SAMPLE_MINUTES,
    );
    expect(bucketMinutesFor(at('2026-09-05T12:00:00Z'), at('2026-09-06T12:00:00Z'))).toBe(
      SAMPLE_MINUTES,
    );
    expect(bucketMinutesFor(at('2026-09-01T12:00:00Z'), at('2026-09-08T12:00:00Z'))).toBe(30);
    expect(bucketMinutesFor(at('2026-08-06T12:00:00Z'), at('2026-09-05T12:00:00Z'))).toBe(120);
  });

  it('groups a longer period into coarser points', async () => {
    // A month of quarter-hours is 2,880 points per channel, and there are as
    // many channels as the site is listing. Longer periods are grouped instead.
    const at = (day: number, time: string) => new Date(`2026-09-0${day}T${time}:00.000Z`);
    await sampleOnce([listed('kick', 'destiny', 10)], at(5, '12:00'), db);
    await sampleOnce([listed('kick', 'destiny', 30)], at(5, '12:15'), db);

    const history = await getStreamWatchHistory(at(1, '00:00'), at(8, '00:00'), null, db);

    expect(history.bucketMinutes).toBe(30);
    // Two stored readings, one point: the half hour holds both.
    expect(history.samples).toHaveLength(1);
    // The busiest reading in the bucket, not the last one: a peak that lasted
    // one interval is the thing worth seeing at this width.
    expect(history.samples[0]).toMatchObject({ siteCount: 30 });
  });

  it('draws the busiest channels when it was not told which', async () => {
    const at = new Date('2026-09-05T12:00:00.000Z');
    const crowd = Array.from({ length: 12 }, (_, index) =>
      listed('kick', `channel${index}`, 100 + index),
    );
    // The channel the overlay follows is on the list like any other, and this
    // one is the quietest thing on it — so the ranking drops it.
    await sampleOnce([...crowd, listed('kick', 'dggjams', 2)], at, db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T11:00:00.000Z'),
      new Date('2026-09-05T13:00:00.000Z'),
      null,
      db,
    );

    const drawn = history.samples.map((sample) => sample.channel);
    expect(drawn).toHaveLength(8);
    expect(drawn).toContain('channel11');
    expect(drawn).not.toContain('channel0');
    expect(drawn).not.toContain('dggjams');
    // And it says which eight it chose, so a second query over a narrower
    // window can ask for exactly those rather than ranking again. Ranked by
    // peak; the samples themselves come back by time.
    expect(history.channels[0]).toBe('kick/channel11');
    expect([...history.channels].sort()).toEqual(drawn.map((channel) => `kick/${channel}`).sort());
  });

  it('draws the channels it was asked for, however quiet they are', async () => {
    const at = new Date('2026-09-05T12:00:00.000Z');
    const crowd = Array.from({ length: 12 }, (_, index) =>
      listed('kick', `channel${index}`, 100 + index),
    );
    await sampleOnce([...crowd, listed('kick', 'zugami', 2)], at, db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T11:00:00.000Z'),
      new Date('2026-09-05T13:00:00.000Z'),
      ['kick/zugami', 'kick/channel0'],
      db,
    );

    // The two asked for, and neither is one the ranking would have offered.
    expect(history.channels).toEqual(['kick/zugami', 'kick/channel0']);
    expect(history.samples.map((sample) => sample.channel).sort()).toEqual([
      'channel0',
      'zugami',
    ]);
    // Everything else is still summed, so a narrow choice says what it is part
    // of: the eleven of the crowd that were not asked for.
    expect(history.otherChannels).toBe(11);
    expect(history.other[0]?.siteCount).toBe(
      Array.from({ length: 11 }, (_, index) => 101 + index).reduce((sum, n) => sum + n, 0),
    );
  });

  it('lists every channel a period saw, busiest first, however small', async () => {
    const at = new Date('2026-09-05T12:00:00.000Z');
    await sampleOnce(
      [listed('kick', 'destiny', 400), listed('kick', 'dggjams', 2), listed('youtube', 'quiet', 1)],
      at,
      db,
    );

    const channels = await listStreamWatchChannels(
      new Date('2026-09-05T11:00:00.000Z'),
      new Date('2026-09-05T13:00:00.000Z'),
      db,
    );

    // Peak, and nothing else: a list cut to the busiest could never offer
    // `youtube/quiet`, which is the whole reason to choose rather than take the
    // top eight, and the followed channel is ranked like anything else.
    expect(channels.map((channel) => `${channel.platform}/${channel.channel}`)).toEqual([
      'kick/destiny',
      'kick/dggjams',
      'youtube/quiet',
    ]);
    expect(channels[0]).toMatchObject({ peak: 400 });
    expect(channels[2]).toMatchObject({ peak: 1 });
  });

  it('returns only samples inside the requested period', async () => {
    const entries = [listed('kick', 'destiny', 840)];
    await sampleOnce(entries, new Date('2026-09-05T18:45:00.000Z'), db);
    await sampleOnce(entries, new Date('2026-09-05T19:00:00.000Z'), db);
    await sampleOnce(entries, new Date('2026-09-05T20:00:00.000Z'), db);

    const history = await getStreamWatchHistory(
      new Date('2026-09-05T19:00:00.000Z'),
      new Date('2026-09-05T19:30:00.000Z'),
      null,
      db,
    );
    expect(history).toEqual({
      from: '2026-09-05T19:00:00.000Z',
      to: '2026-09-05T19:30:00.000Z',
      bucketMinutes: SAMPLE_MINUTES,
      other: [],
      otherChannels: 0,
      channels: ['kick/destiny'],
      samples: [
        {
          sampledAt: '2026-09-05T19:00:00.000Z',
          platform: 'kick',
          channel: 'destiny',
          siteCount: 840,
        },
      ],
    });
  });
});
