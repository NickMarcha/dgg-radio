import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type {
  StreamWatchHistory,
  StreamWatchSample,
  StreamWatchSettings,
  StreamWatchStatus,
  Watcher,
  WatchersSnapshot,
} from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { streamWatch, streamWatchSamples, users } from './db/schema';
import { ChatTracker, type WatchedChannel } from './dgg-chat';
import { EmbedsTracker, type EmbedEntry } from './dgg-embeds';
import { ensureEmoteCatalogue, lastEmoteIn, type EmoteCatalogue } from './dgg-emotes';

/**
 * Watching one destiny.gg embed: how many people the site says are on it, and
 * which chatters they are.
 *
 * The live socket is held whenever tracking is on, because it is one message
 * every half minute and it is the only way to know whether anybody is there.
 * The chat socket is held only while somebody is, and dropped again after a
 * grace period. Its stream is small — about 1.6 events a second — so this is
 * about not sitting on somebody else's chat connection for nothing rather than
 * about the cost of reading it.
 */
const CHAT_IDLE_GRACE_MS = 2 * 60 * 1_000;

/** How often the gate is reconsidered. The embed list only moves every 30 seconds. */
const REFRESH_MS = 15_000;

/** Counts are stored at this cadence, in minute buckets. */
const SAMPLE_MS = 60_000;

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

/**
 * Store this minute's reading of every embed the site listed, plus the followed
 * channel, which is the only one with a chat roster behind it. Repeating a
 * write inside the same minute updates those rows rather than adding more, so a
 * restart costs nothing and a channel appearing mid-minute is simply recorded.
 */
export async function recordStreamWatchSample(
  entries: EmbedEntry[],
  tracked: WatchersSnapshot,
  at: Date = new Date(),
  db: Database = getDatabase(),
): Promise<void> {
  const sampledAt = new Date(Math.floor(at.getTime() / SAMPLE_MS) * SAMPLE_MS);
  const rows = new Map<string, typeof streamWatchSamples.$inferInsert>();

  for (const entry of entries) {
    const channel = entry.id.toLowerCase();
    rows.set(`${entry.platform}/${channel}`, {
      sampledAt,
      platform: entry.platform,
      channel,
      siteCount: entry.count,
      chatCount: null,
    });
  }

  // The followed channel carries its roster count, and is recorded even in a
  // minute the site did not list it — that absence is a reading too.
  if (tracked.channel) {
    const key = `${tracked.channel.platform}/${tracked.channel.id}`;
    rows.set(key, {
      sampledAt,
      platform: tracked.channel.platform,
      channel: tracked.channel.id,
      siteCount: rows.get(key)?.siteCount ?? tracked.siteCount,
      chatCount: tracked.chatCount,
    });
  }

  if (rows.size === 0) return;

  await db
    .insert(streamWatchSamples)
    .values([...rows.values()])
    .onConflictDoUpdate({
      target: [
        streamWatchSamples.sampledAt,
        streamWatchSamples.platform,
        streamWatchSamples.channel,
      ],
      set: {
        siteCount: sql`excluded.site_count`,
        chatCount: sql`excluded.chat_count`,
      },
    });
}

/**
 * How wide one point of the graph is. A week of minutes is 10,080 points per
 * channel and there are as many channels as the site is listing, so a longer
 * period is grouped more coarsely rather than sent in full.
 */
export function bucketMinutesFor(from: Date, to: Date): number {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours <= 6) return 1;
  if (hours <= 24) return 5;
  if (hours <= 72) return 15;
  if (hours <= 168) return 30;
  return 120;
}

/**
 * How many channels are drawn as themselves. Eight is the number of hues that
 * can be told apart on one chart, so it is a limit of the drawing rather than
 * of the query; everything past it is summed into one line.
 */
const HISTORY_TARGETS = 8;

export async function getStreamWatchHistory(
  from: Date,
  to: Date,
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
      platform: streamWatchSamples.platform,
      channel: streamWatchSamples.channel,
      siteCount: sql<number | null>`max(${streamWatchSamples.siteCount})`,
      chatCount: sql<number | null>`max(${streamWatchSamples.chatCount})`,
    })
    .from(streamWatchSamples)
    .where(and(gte(streamWatchSamples.sampledAt, from), lte(streamWatchSamples.sampledAt, to)))
    .groupBy(bucket, streamWatchSamples.platform, streamWatchSamples.channel)
    .orderBy(asc(bucket), asc(streamWatchSamples.platform), asc(streamWatchSamples.channel));

  // The busiest channels, and always the followed one: it is the only row with
  // a chat count, which is the half of this nobody else can be drawn with.
  const peaks = new Map<string, { peak: number; followed: boolean }>();
  for (const row of rows) {
    const key = `${row.platform}/${row.channel}`;
    const seen = peaks.get(key) ?? { peak: 0, followed: false };
    peaks.set(key, {
      peak: Math.max(seen.peak, row.siteCount ?? 0),
      followed: seen.followed || row.chatCount !== null,
    });
  }
  const drawn = new Set(
    [...peaks.entries()]
      .sort(
        ([, left], [, right]) =>
          Number(right.followed) - Number(left.followed) || right.peak - left.peak,
      )
      .slice(0, HISTORY_TARGETS)
      .map(([key]) => key),
  );

  const samples: StreamWatchSample[] = [];
  const otherByBucket = new Map<string, number>();
  const otherChannels = new Set<string>();

  for (const row of rows) {
    const key = `${row.platform}/${row.channel}`;
    const sampledAt = new Date(row.sampledAt).toISOString();
    if (drawn.has(key)) {
      samples.push({
        sampledAt,
        platform: row.platform,
        channel: row.channel,
        siteCount: row.siteCount === null ? null : Number(row.siteCount),
        chatCount: row.chatCount === null ? null : Number(row.chatCount),
      });
      continue;
    }
    otherChannels.add(key);
    otherByBucket.set(sampledAt, (otherByBucket.get(sampledAt) ?? 0) + Number(row.siteCount ?? 0));
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
  private members = new Map<string, string | null>();
  private overlayCount: () => number = () => 0;
  private catalogue: EmoteCatalogue | null = null;

  /** Reads the settings again and brings both sockets in line with them. */
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

    if (!this.settings.enabled) {
      this.embeds.stop();
      this.stopChat();
      return;
    }

    // The live socket is held for the whole of tracking, not for one channel:
    // its list is what the graph records for every embed on the site, and the
    // followed channel is only the one that also gets a chat roster.
    this.embeds.start();

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
    await this.refresh();
    this.timer ??= setInterval(() => {
      void this.refresh().catch((error) => console.error('Stream watch refresh failed', error));
    }, REFRESH_MS);
    this.sampleTimer ??= setInterval(() => {
      if (this.sampleBusy) return;
      this.sampleBusy = true;
      void recordStreamWatchSample(this.embeds.all(), this.snapshot())
        .catch((error) => console.error('Stream watch sample failed', error))
        .finally(() => {
          this.sampleBusy = false;
        });
    }, SAMPLE_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.timer = null;
    this.sampleTimer = null;
    this.sampleBusy = false;
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
