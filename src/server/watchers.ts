import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  StreamWatchChannel,
  StreamWatchHistory,
  StreamWatchSample,
  StreamWatchSettings,
  StreamWatchStatus,
  Watcher,
  WatchersSnapshot,
} from '../shared/contracts';
import { STREAM_WATCH_MAX_CHANNELS } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { streamWatch, streamWatchChannels, streamWatchSamples, users } from './db/schema';
import { ChatTracker, type WatchedChannel } from './dgg-chat';
import { EmbedsTracker, type EmbedEntry } from './dgg-embeds';
import { ensureEmoteCatalogue, lastEmoteIn, type EmoteCatalogue } from './dgg-emotes';

/**
 * Watching destiny.gg's embeds: how many people the site says are on each, and,
 * for the one channel the room follows, which chatters they are.
 *
 * The two sockets answer different questions and so are held on different
 * terms. The live socket is held for the life of the process: its list is the
 * room's record of what the site was watching, one message every half minute,
 * and a minute nobody was connected is a minute of history that cannot be
 * recovered afterwards. The chat socket is held only while there is a followed
 * channel and somebody on it, and dropped again after a grace period — its
 * stream is small, about 1.6 events a second, so that is about not sitting on
 * somebody else's chat connection for nothing rather than about the cost.
 */
const CHAT_IDLE_GRACE_MS = 2 * 60 * 1_000;

/** How often the gate is reconsidered. The embed list only moves every 30 seconds. */
const REFRESH_MS = 15_000;

/**
 * How often a row is stored, and the width of the bucket it is stored in.
 *
 * A row was once kept for every minute, which is a row per listed channel per
 * minute — some nine million rows a year that nobody would ever read at that
 * resolution. A quarter of an hour answers every question this history is
 * opened to answer at a fifteenth of the rows.
 */
const SAMPLE_MS = 15 * 60_000;

/**
 * How often the list is read into the running average.
 *
 * The stored number is the mean of these rather than whatever the list happened
 * to say when the interval ended. It costs nothing — the readings are added up
 * in memory and one row is written per interval either way — and it is the
 * difference between a quarter-hour point that describes the quarter hour and
 * one that describes the instant it was taken.
 */
const OBSERVE_MS = 60_000;

/** Enough for any overlay, and it keeps the response small on a busy channel. */
const WATCHER_LIMIT = 100;

/**
 * The room's own people, by lowercase username, each with the emote they are
 * drawn as. The table is small and a roster is not, so the whole thing is read
 * once a refresh and intersected in memory rather than queried nick by nick.
 */
async function loadMembers(db: Database): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ username: users.username, topEmote: users.topEmote })
    .from(users);
  return new Map(rows.map((row) => [row.username.toLowerCase(), row.topEmote]));
}

/**
 * At most `WATCHER_LIMIT` of them, but never at a member's expense: a plain cut
 * keeps the most recently active, and `show=members` on a busy channel would
 * then miss the people it exists to draw. The order is left alone.
 */
function capWatchers(watchers: Watcher[]): Watcher[] {
  if (watchers.length <= WATCHER_LIMIT) return watchers;
  const members = watchers.filter((watcher) => watcher.member);
  const room = WATCHER_LIMIT - members.length;
  const others = watchers.filter((watcher) => !watcher.member).slice(0, Math.max(0, room));
  const keep = new Set([...members, ...others]);
  return watchers.filter((watcher) => keep.has(watcher));
}

export async function getStreamWatchSettings(
  db: Database = getDatabase(),
): Promise<StreamWatchSettings> {
  await db.insert(streamWatch).values({ id: 1 }).onConflictDoNothing();
  const [row] = await db
    .select({
      enabled: streamWatch.enabled,
      platform: streamWatch.platform,
      channel: streamWatch.channel,
      updatedAt: streamWatch.updatedAt,
    })
    .from(streamWatch)
    .where(eq(streamWatch.id, 1));

  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export interface StreamWatchUpdate {
  enabled?: boolean;
  platform?: StreamWatchSettings['platform'];
  channel?: string;
}

export async function updateStreamWatchSettings(
  update: StreamWatchUpdate,
  userId: string,
  db: Database = getDatabase(),
): Promise<StreamWatchSettings> {
  await getStreamWatchSettings(db);
  await db
    .update(streamWatch)
    .set({
      ...update,
      // Chat reports channel ids lowercase; the bigscreen link is written
      // `#kick/dggJams`, so an admin will type it either way.
      ...(update.channel === undefined ? {} : { channel: update.channel.trim().toLowerCase() }),
      updatedAt: new Date(),
      updatedByUserId: userId,
    })
    .where(eq(streamWatch.id, 1));

  return getStreamWatchSettings(db);
}

/** The start of the interval an instant falls in, which is how a row is keyed. */
export function intervalStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SAMPLE_MS) * SAMPLE_MS);
}

/**
 * One interval's readings, added up as they arrive.
 *
 * A channel missing from a reading counts as zero rather than being skipped,
 * because the site only lists an embed somebody has open — so its absence is a
 * measurement. The divisor is how many times the list was read, not how many
 * times this channel was in it, which is what keeps a channel watched by four
 * hundred people for one minute of the quarter hour from reading as four
 * hundred, while also not punishing a channel for the minutes nobody looked.
 */
export class SampleAverage {
  private readonly totals = new Map<string, { platform: string; channel: string; total: number }>();
  private observations = 0;

  constructor(readonly startedAt: Date) {}

  add(entries: EmbedEntry[]): void {
    this.observations += 1;
    for (const entry of entries) {
      const channel = entry.id.toLowerCase();
      const key = `${entry.platform}/${channel}`;
      const seen = this.totals.get(key) ?? { platform: entry.platform, channel, total: 0 };
      seen.total += entry.count;
      this.totals.set(key, seen);
    }
  }

  /** The mean per channel, rounded, for every channel seen at least once. */
  means(): { platform: string; channel: string; siteCount: number }[] {
    if (this.observations === 0) return [];
    return [...this.totals.values()].map((seen) => ({
      platform: seen.platform,
      channel: seen.channel,
      siteCount: Math.round(seen.total / this.observations),
    }));
  }
}

/**
 * The id for every channel named, creating the ones that are new.
 *
 * The whole table is read back rather than only the ids just asked for: it is
 * one row per channel the sampler has ever seen, so it is tens of rows, and one
 * unfiltered select is cheaper than building a predicate over pairs.
 */
async function channelIds(
  named: { platform: string; channel: string }[],
  db: Database,
): Promise<Map<string, number>> {
  if (named.length > 0) {
    await db.insert(streamWatchChannels).values(named).onConflictDoNothing();
  }
  const rows = await db
    .select({
      id: streamWatchChannels.id,
      platform: streamWatchChannels.platform,
      channel: streamWatchChannels.channel,
    })
    .from(streamWatchChannels);
  return new Map(rows.map((row) => [keyOf(row), row.id]));
}

/**
 * Store one interval's average for every embed the site listed in it.
 *
 * Every channel is recorded the same way, the followed one included: what is
 * kept here is destiny.gg's own count of open embeds, and the chat roster the
 * overlay draws is a live thing that is never written down. Writing the same
 * interval twice updates those rows rather than adding more, so a restart
 * cannot double up.
 */
export async function recordStreamWatchSample(
  average: SampleAverage,
  db: Database = getDatabase(),
): Promise<void> {
  const means = average.means();
  if (means.length === 0) return;

  const ids = await channelIds(
    means.map(({ platform, channel }) => ({ platform, channel })),
    db,
  );

  await db
    .insert(streamWatchSamples)
    .values(
      means.map((mean) => ({
        sampledAt: average.startedAt,
        channelId: ids.get(keyOf(mean))!,
        siteCount: mean.siteCount,
      })),
    )
    .onConflictDoUpdate({
      target: [streamWatchSamples.sampledAt, streamWatchSamples.channelId],
      set: { siteCount: sql`excluded.site_count` },
    });
}

/**
 * How long a reading is kept at the interval it was taken at. Past this it is
 * averaged down to one point an hour, in place, which is a quarter of the rows
 * for a period no chart can draw at finer than two hours anyway.
 */
export const DETAIL_DAYS = 90;

/** How often the window is swept. It moves by a day; there is no hurry. */
const DOWNSAMPLE_MS = 24 * 3_600_000;

/**
 * Roll readings older than the detail window down to one an hour.
 *
 * Two statements rather than one: a data-modifying CTE would not see its own
 * delete, so an on-the-hour row would be aggregated and removed in the same
 * breath. Averaging first and deleting only what is not on the hour is also
 * idempotent — run twice, the second pass groups each hourly row alone, which
 * is itself.
 *
 * @returns how many rows it removed, for the log.
 */
export async function downsampleStreamWatchSamples(
  now: Date = new Date(),
  db: Database = getDatabase(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DETAIL_DAYS * 24 * 3_600_000);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into ${streamWatchSamples} (sampled_at, channel_id, site_count)
      select date_trunc('hour', ${streamWatchSamples.sampledAt}),
             ${streamWatchSamples.channelId},
             round(avg(${streamWatchSamples.siteCount}))::int
      from ${streamWatchSamples}
      where ${streamWatchSamples.sampledAt} < ${cutoff}
      group by 1, 2
      on conflict (sampled_at, channel_id) do update set site_count = excluded.site_count
    `);

    const removed = await tx.execute<{ count: string }>(sql`
      with gone as (
        delete from ${streamWatchSamples}
        where ${streamWatchSamples.sampledAt} < ${cutoff}
          and ${streamWatchSamples.sampledAt} <> date_trunc('hour', ${streamWatchSamples.sampledAt})
        returning 1
      )
      select count(*)::bigint as count from gone
    `);

    return Number(removed.rows[0]?.count ?? 0);
  });
}

/**
 * How wide one point of the graph is.
 *
 * The floor is the sampling interval, because a narrower bucket cannot hold
 * more than one reading and would only draw the same points further apart. Past
 * that a longer period is grouped more coarsely rather than sent in full: a
 * month at quarter-hour points is 2,880 per channel, and there are as many
 * channels as the site is listing.
 */
export const SAMPLE_MINUTES = SAMPLE_MS / 60_000;

export function bucketMinutesFor(from: Date, to: Date): number {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours <= 72) return SAMPLE_MINUTES;
  if (hours <= 168) return 30;
  return 120;
}

/** `platform/channel`, the way every caller names one. */
function keyOf(row: { platform: string; channel: string }): string {
  return `${row.platform}/${row.channel}`;
}

/**
 * Every channel sampled in a period, busiest first, for choosing what to draw.
 *
 * One grouped pass over the period. It is deliberately not capped: a chart can
 * only tell eight channels apart, but the reason to choose at all is to reach a
 * quiet channel, and a list cut to the busiest could never offer one.
 */
export async function listStreamWatchChannels(
  from: Date,
  to: Date,
  db: Database = getDatabase(),
): Promise<StreamWatchChannel[]> {
  const rows = await db
    .select({
      platform: streamWatchChannels.platform,
      channel: streamWatchChannels.channel,
      peak: sql<number>`max(${streamWatchSamples.siteCount})`,
      lastSeenAt: sql<Date>`max(${streamWatchSamples.sampledAt})`,
    })
    .from(streamWatchSamples)
    .innerJoin(streamWatchChannels, eq(streamWatchChannels.id, streamWatchSamples.channelId))
    .where(and(gte(streamWatchSamples.sampledAt, from), lte(streamWatchSamples.sampledAt, to)))
    .groupBy(streamWatchChannels.platform, streamWatchChannels.channel);

  return rows
    .map((row) => ({
      platform: row.platform,
      channel: row.channel,
      peak: Number(row.peak),
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    }))
    .sort(
      (left, right) => right.peak - left.peak || keyOf(left).localeCompare(keyOf(right)),
    );
}

/** Which channels a chart draws when nobody has chosen: simply the busiest. */
function busiestChannels(
  rows: { platform: string; channel: string; siteCount: number | null }[],
): string[] {
  const peaks = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    peaks.set(key, Math.max(peaks.get(key) ?? 0, row.siteCount ?? 0));
  }

  return [...peaks.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, STREAM_WATCH_MAX_CHANNELS)
    .map(([key]) => key);
}

/**
 * @param channels the `platform/channel` keys to draw as themselves, or null to
 * take the busiest. Everything not in it is summed into the single other line,
 * so a narrow choice still says how much of the site it is a part of.
 */
export async function getStreamWatchHistory(
  from: Date,
  to: Date,
  channels: string[] | null = null,
  db: Database = getDatabase(),
): Promise<StreamWatchHistory> {
  const bucketMinutes = bucketMinutesFor(from, to);
  // The width is written into the statement rather than bound to it: a bound
  // parameter makes the copy in `group by` a different expression from the one
  // in `select`, and Postgres then asks to have the raw column grouped instead.
  // It is one of four numbers this module chooses, never anything from outside.
  const seconds = sql.raw(String(bucketMinutes * 60));
  const bucket = sql<Date>`to_timestamp(floor(extract(epoch from ${streamWatchSamples.sampledAt}) / ${seconds}) * ${seconds})`;

  const rows = await db
    .select({
      sampledAt: bucket,
      platform: streamWatchChannels.platform,
      channel: streamWatchChannels.channel,
      siteCount: sql<number>`max(${streamWatchSamples.siteCount})`,
    })
    .from(streamWatchSamples)
    .innerJoin(streamWatchChannels, eq(streamWatchChannels.id, streamWatchSamples.channelId))
    .where(and(gte(streamWatchSamples.sampledAt, from), lte(streamWatchSamples.sampledAt, to)))
    .groupBy(bucket, streamWatchChannels.platform, streamWatchChannels.channel)
    .orderBy(asc(bucket), asc(streamWatchChannels.platform), asc(streamWatchChannels.channel));

  const chosen = channels?.slice(0, STREAM_WATCH_MAX_CHANNELS) ?? busiestChannels(rows);
  const drawn = new Set(chosen);

  const samples: StreamWatchSample[] = [];
  const otherByBucket = new Map<string, number>();
  const otherChannels = new Set<string>();

  for (const row of rows) {
    const key = keyOf(row);
    const sampledAt = new Date(row.sampledAt).toISOString();
    if (drawn.has(key)) {
      samples.push({
        sampledAt,
        platform: row.platform,
        channel: row.channel,
        siteCount: Number(row.siteCount),
      });
      continue;
    }
    otherChannels.add(key);
    otherByBucket.set(sampledAt, (otherByBucket.get(sampledAt) ?? 0) + Number(row.siteCount));
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucketMinutes,
    samples,
    other: [...otherByBucket.entries()]
      .map(([sampledAt, siteCount]) => ({ sampledAt, siteCount }))
      .sort((left, right) => left.sampledAt.localeCompare(right.sampledAt)),
    otherChannels: otherChannels.size,
    channels: chosen,
  };
}

function channelOf(settings: StreamWatchSettings): WatchedChannel | null {
  if (!settings.enabled || !settings.channel) return null;
  return { platform: settings.platform, id: settings.channel };
}

class WatchTracker {
  // The first embed list decides whether the chat socket is wanted, and it
  // arrives seconds after the live socket opens. Waiting for the next refresh
  // to notice would leave the room blind for a quarter of a minute each time
  // an admin switches this on.
  private readonly embeds = new EmbedsTracker(() => this.applyGate());
  private chat: ChatTracker | null = null;
  private settings: StreamWatchSettings | null = null;
  private channel: WatchedChannel | null = null;
  private chatWantedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private sampleBusy = false;
  private average: SampleAverage | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private members = new Map<string, string | null>();
  private overlayCount: () => number = () => 0;
  private catalogue: EmoteCatalogue | null = null;

  /** Reads the settings again and brings the chat socket in line with them. */
  async refresh(db: Database = getDatabase()): Promise<void> {
    this.settings = await getStreamWatchSettings(db);
    const channel = channelOf(this.settings);
    // A different channel shares nothing with the old one, including the grace
    // period: the chat socket was being held for people watching something
    // else, and holding it two more minutes for that reason would be wrong.
    if (channel?.id !== this.channel?.id || channel?.platform !== this.channel?.platform) {
      this.chatWantedAt = null;
    }
    this.channel = channel;

    if (!channel) {
      this.stopChat();
      return;
    }

    this.members = await loadMembers(db);
    this.catalogue = await ensureEmoteCatalogue();
    this.applyGate();
  }

  /**
   * Whether the chat socket is worth holding, decided from what is already
   * known. Somebody on the embed is one reason and an open overlay is the
   * other, so a stream about to start can be watched before anybody arrives.
   * The grace period is so a channel dipping to nobody for a moment does not
   * close and reopen it.
   */
  private applyGate(): void {
    const channel = this.channel;
    if (!channel) return;

    this.chat ??= new ChatTracker(channel, (text, subTier) =>
      this.catalogue === null ? null : lastEmoteIn(text, this.catalogue, subTier),
    );
    this.chat.watch(channel);

    const someoneIsWatching =
      (this.embeds.entryFor(channel)?.count ?? 0) > 0 || this.overlayCount() > 0;
    if (someoneIsWatching) {
      this.chatWantedAt = Date.now();
      this.chat.start();
      return;
    }

    if (this.chatWantedAt === null || Date.now() - this.chatWantedAt > CHAT_IDLE_GRACE_MS) {
      this.stopChat();
    }
  }

  /** @param overlayCount how many overlays are connected, which keeps chat open on its own. */
  async start(overlayCount: () => number = () => 0): Promise<void> {
    this.overlayCount = overlayCount;
    // The embed list is recorded whether or not a channel is followed, so this
    // starts before the settings are read and stays up until the process ends.
    this.embeds.start();
    await this.refresh();
    this.timer ??= setInterval(() => {
      void this.refresh().catch((error) => console.error('Stream watch refresh failed', error));
    }, REFRESH_MS);
    this.sampleTimer ??= setInterval(() => this.observe(), OBSERVE_MS);
    this.observe();
    // Once a day is often enough for a window measured in months, and once at
    // startup means a room that was off for a while catches up when it returns.
    this.retentionTimer ??= setInterval(() => this.roll(), DOWNSAMPLE_MS);
    this.roll();
  }

  private roll(): void {
    void downsampleStreamWatchSamples()
      .then((removed) => {
        if (removed > 0) {
          console.log(
            `Stream watch: rolled ${removed.toLocaleString()} readings older than ` +
              `${DETAIL_DAYS} days down to one an hour`,
          );
        }
      })
      .catch((error) => console.error('Stream watch downsample failed', error));
  }

  /**
   * Read the list into the running average, and write the last one out when the
   * clock crosses into a new interval.
   *
   * Nothing is written until an interval has ended, so a process that restarts
   * more often than that loses the part-interval it was accumulating. That is a
   * gap in the graph rather than a wrong number, and it costs one write every
   * quarter of an hour instead of fifteen updates to the same row.
   */
  private observe(): void {
    const startedAt = intervalStart(new Date());
    const finished =
      this.average !== null && this.average.startedAt.getTime() !== startedAt.getTime()
        ? this.average
        : null;
    if (this.average === null || finished !== null) this.average = new SampleAverage(startedAt);
    this.average.add(this.embeds.all());

    if (finished === null || this.sampleBusy) return;
    this.sampleBusy = true;
    void recordStreamWatchSample(finished)
      .catch((error) => console.error('Stream watch sample failed', error))
      .finally(() => {
        this.sampleBusy = false;
      });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.timer = null;
    this.sampleTimer = null;
    this.retentionTimer = null;
    this.sampleBusy = false;
    this.average = null;
    this.embeds.stop();
    this.stopChat();
  }

  snapshot(): WatchersSnapshot {
    const channel = this.channel;
    if (!channel) {
      return { channel: null, live: false, siteCount: null, chatCount: 0, watchers: [] };
    }

    const entry = this.embeds.entryFor(channel);
    const watchers = (this.chat?.watchers() ?? []).map((watcher) => {
      const emote = this.members.get(watcher.nick.toLowerCase());
      return { ...watcher, member: emote !== undefined, emote: emote ?? null };
    });

    return {
      channel: { platform: channel.platform, id: channel.id },
      live: entry !== null,
      siteCount: entry?.count ?? null,
      chatCount: this.chat?.count() ?? 0,
      watchers: capWatchers(watchers),
    };
  }

  async status(db: Database = getDatabase()): Promise<StreamWatchStatus> {
    return {
      settings: this.settings ?? (await getStreamWatchSettings(db)),
      sockets: {
        live: this.embeds.state(),
        chat: this.chat?.state() ?? { connected: false, lastFrameAt: null, attempts: 0 },
      },
      snapshot: this.snapshot(),
    };
  }

  private stopChat(): void {
    this.chat?.stop();
    this.chat = null;
    this.chatWantedAt = null;
  }
}

/**
 * One tracker for the process, the way the room has one clock. Nothing outside
 * this module touches the sockets.
 */
export const watchTracker = new WatchTracker();
