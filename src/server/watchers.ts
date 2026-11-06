import { and, eq, ne } from 'drizzle-orm';
import type {
  StreamWatchSettings,
  StreamWatchStatus,
  Watcher,
  WatchersSnapshot,
  WatchSocketState,
} from '../shared/contracts';
import { captureServerEvent } from './analytics';
import { getDatabase, type Database } from './db/client';
import { streamWatch, users } from './db/schema';
import { ChatTracker, channelKey, type WatchedChannel } from './dgg-chat';
import { EmbedsTracker } from './dgg-embeds';
import { ensureEmoteCatalogue, lastEmoteIn, type EmoteCatalogue } from './dgg-emotes';

/**
 * Watching destiny.gg's embeds: how many people the site says are on each, and,
 * for the channel each room follows, which chatters they are.
 *
 * The two sockets answer different questions and so are held on different
 * terms. The live socket is held for the life of the process: it is one
 * message every half minute, it is what says whether anybody is on the
 * followed channel, and its health is what `/health` reports. Nothing it says
 * is stored; mitchdev.net/dgg/embeds keeps that history.
 *
 * One chat socket serves every followed channel, because every chat event says
 * what its user is watching. It is held only while some room follows a channel
 * and somebody is on one, and dropped again after a grace period. Its stream is small, about 1.6
 * events a second, so that is about not sitting on somebody else's chat
 * connection for nothing rather than about the cost.
 */
const CHAT_IDLE_GRACE_MS = 2 * 60 * 1_000;

/** How often the gate is reconsidered. The embed list only moves every 30 seconds. */
const REFRESH_MS = 15_000;

/**
 * How long the live socket may be down before it is an outage rather than a
 * reconnect.
 *
 * destiny.gg closes clients routinely — 1001 Going Away when Cloudflare cycles
 * a server — and the retry ladder answers those in under a second. Even its cap
 * is a minute. So five minutes down is nothing the room recovers from by
 * itself, and a healthy room reports nothing at all, which is what makes this
 * worth putting in front of an alert.
 */
const SOCKET_DOWN_MS = 5 * 60_000;

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
  roomId: string,
  db: Database = getDatabase(),
): Promise<StreamWatchSettings> {
  await db.insert(streamWatch).values({ roomId }).onConflictDoNothing();
  const [row] = await db
    .select({
      enabled: streamWatch.enabled,
      platform: streamWatch.platform,
      channel: streamWatch.channel,
      updatedAt: streamWatch.updatedAt,
    })
    .from(streamWatch)
    .where(eq(streamWatch.roomId, roomId));

  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export interface StreamWatchUpdate {
  enabled?: boolean;
  platform?: StreamWatchSettings['platform'];
  channel?: string;
}

export async function updateStreamWatchSettings(
  roomId: string,
  update: StreamWatchUpdate,
  userId: string,
  db: Database = getDatabase(),
): Promise<StreamWatchSettings> {
  await getStreamWatchSettings(roomId, db);
  await db
    .update(streamWatch)
    .set({
      ...update,
      // Chat reports channel ids lowercase; the bigscreen link is written
      // `#kick/dggJams`, so an owner will type it either way.
      ...(update.channel === undefined ? {} : { channel: update.channel.trim().toLowerCase() }),
      updatedAt: new Date(),
      updatedByUserId: userId,
    })
    .where(eq(streamWatch.roomId, roomId));

  return getStreamWatchSettings(roomId, db);
}

/** The channel each room follows, for the rooms that follow one. */
async function loadFollowedChannels(db: Database): Promise<Map<string, WatchedChannel>> {
  const rows = await db
    .select({ roomId: streamWatch.roomId, platform: streamWatch.platform, channel: streamWatch.channel })
    .from(streamWatch)
    .where(and(eq(streamWatch.enabled, true), ne(streamWatch.channel, '')));
  return new Map(rows.map((row) => [row.roomId, { platform: row.platform, id: row.channel }]));
}

const NO_SOCKET: WatchSocketState = { connected: false, lastFrameAt: null, downSince: null, attempts: 0 };

class WatchTracker {
  // The first embed list decides whether the chat socket is wanted, and it
  // arrives seconds after the live socket opens. Waiting for the next refresh
  // to notice would leave the rooms blind for a quarter of a minute each time
  // an owner switches this on.
  private readonly embeds = new EmbedsTracker(() => this.applyGate());
  private chat: ChatTracker | null = null;
  /** Room id to the channel it follows. Two rooms may follow one channel. */
  private followed = new Map<string, WatchedChannel>();
  private chatWantedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private members = new Map<string, string | null>();
  private overlayCount: () => number = () => 0;
  private catalogue: EmoteCatalogue | null = null;
  /** So one outage is one event, rather than one every fifteen seconds. */
  private liveOutageReported = false;

  /** Reads every room's settings again and brings the chat socket in line with them. */
  async refresh(db: Database = getDatabase()): Promise<void> {
    this.followed = await loadFollowedChannels(db);
    if (this.followed.size === 0) {
      this.stopChat();
      return;
    }

    this.members = await loadMembers(db);
    this.catalogue = await ensureEmoteCatalogue();
    this.applyGate();
  }

  /** Every followed channel once, however many rooms follow it. */
  private channels(): WatchedChannel[] {
    const unique = new Map<string, WatchedChannel>();
    for (const channel of this.followed.values()) unique.set(channelKey(channel), channel);
    return [...unique.values()];
  }

  /**
   * Whether the chat socket is worth holding, decided from what is already
   * known. Somebody on a followed embed is one reason and an open overlay is
   * the other, so a stream about to start can be watched before anybody
   * arrives. The grace period is so a channel dipping to nobody for a moment
   * does not close and reopen it.
   */
  private applyGate(): void {
    const channels = this.channels();
    if (channels.length === 0) return;

    this.chat ??= new ChatTracker((text, subTier) =>
      this.catalogue === null ? null : lastEmoteIn(text, this.catalogue, subTier),
    );
    this.chat.watch(channels);

    const someoneIsWatching =
      channels.some((channel) => (this.embeds.entryFor(channel)?.count ?? 0) > 0) ||
      this.overlayCount() > 0;
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
    // The embed list is read whether or not a channel is followed, so this
    // starts before the settings are read and stays up until the process ends.
    this.embeds.start();
    await this.refresh();
    this.timer ??= setInterval(() => {
      // Outside the refresh, which returns early when no channel is followed.
      // The live socket is up either way, so its health is asked about either
      // way.
      this.reportLiveSocketHealth();
      void this.refresh().catch((error) => console.error('Stream watch refresh failed', error));
    }, REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.embeds.stop();
    this.stopChat();
  }

  /** Who is watching the channel one room follows. */
  snapshot(roomId: string): WatchersSnapshot {
    const channel = this.followed.get(roomId);
    if (!channel) {
      return { channel: null, live: false, siteCount: null, chatCount: 0, watchers: [] };
    }

    const entry = this.embeds.entryFor(channel);
    const watchers = (this.chat?.watchers(channel) ?? []).map((watcher) => {
      const emote = this.members.get(watcher.nick.toLowerCase());
      return { ...watcher, member: emote !== undefined, emote: emote ?? null };
    });

    return {
      channel: { platform: channel.platform, id: channel.id },
      live: entry !== null,
      siteCount: entry?.count ?? null,
      chatCount: this.chat?.count(channel) ?? 0,
      watchers: capWatchers(watchers),
    };
  }
  /**
   * The live socket's state, read without touching the database so `/health`
   * can carry it. Only the live socket: it is the one held for the life of the
   * process, so it is the only one whose being down is always wrong. The chat
   * socket is closed whenever nobody is watching, which is correct and would
   * make an alert on it noise.
   */
  liveSocket(): WatchSocketState {
    return this.embeds.state();
  }

  /**
   * Writes one event when the live socket has been down long enough to mean
   * something, and nothing at all while it is up.
   *
   * The blind spot is worth naming. The outage this was written for was a DNS
   * failure on the host, which took PostHog out by the same stroke — the events
   * below would have been dropped with everything else. So this covers the
   * ordinary cases, destiny.gg going away or the socket wedging, and the
   * `/health` route carries the same state for something outside the host to
   * poll, which is what catches the case where nothing can get out.
   */
  private reportLiveSocketHealth(): void {
    const { connected, downSince, attempts } = this.embeds.state();
    if (connected || downSince === null) {
      this.liveOutageReported = false;
      return;
    }

    const downForMs = Date.now() - Date.parse(downSince);
    if (downForMs < SOCKET_DOWN_MS || this.liveOutageReported) return;

    this.liveOutageReported = true;
    captureServerEvent('dgg-radio-api', 'watch_socket_down', {
      socket: 'live',
      down_for_minutes: Math.round(downForMs / 60_000),
      attempts,
      threshold_minutes: SOCKET_DOWN_MS / 60_000,
    });
    console.error(
      `Live socket has been down for ${Math.round(downForMs / 60_000)} minutes over ${attempts} attempts`,
    );
  }

  async status(roomId: string, db: Database = getDatabase()): Promise<StreamWatchStatus> {
    return {
      settings: await getStreamWatchSettings(roomId, db),
      sockets: { live: this.embeds.state(), chat: this.chat?.state() ?? NO_SOCKET },
      snapshot: this.snapshot(roomId),
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
