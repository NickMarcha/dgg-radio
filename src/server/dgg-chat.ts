import { z } from 'zod';
import type { Watcher, WatchPlatform } from '../shared/contracts';
import { DggSocket } from './dgg-socket';
import { resolveFlair } from './flair';

/**
 * Destiny chat, read anonymously for one thing: who has a given embed open.
 *
 * Every event carrying a user carries their `watching` too, so the roster is
 * kept from the event stream rather than asked for. What the stream does not
 * carry is a switch: changing embed is not broadcast, and is seen when that
 * person next speaks. `NAMES` on each connect is the correction, so a
 * reconnect is a repair rather than a cost.
 */
export const CHAT_SOCKET_URL = 'wss://chat.destiny.gg/ws';

export interface ChatFrame {
  event: string;
  data: unknown;
}

/**
 * The golang chat service's `EVENT {json}` line format. A payload that is not
 * JSON is kept as text, the way chat-gui's own parser does, so an unexpected
 * frame is ignored rather than fatal.
 */
export function parseChatFrame(raw: string): ChatFrame | null {
  const event = raw.split(' ', 1)[0];
  if (!event) return null;
  const payload = raw.slice(event.length + 1);
  try {
    return { event: event.toUpperCase(), data: JSON.parse(payload) };
  } catch {
    return { event: event.toUpperCase(), data: payload };
  }
}

const chatUserSchema = z.object({
  nick: z.string().min(1),
  features: z.array(z.string()).default([]),
  subscription: z.object({ tier: z.number().int() }).nullable().default(null),
  watching: z
    .object({ platform: z.string(), id: z.string() })
    .nullable()
    .default(null),
  /** Present on MSG and JOIN; milliseconds. */
  timestamp: z.number().optional(),
  /** The message text, on MSG. */
  data: z.string().optional(),
});

type ChatUser = z.infer<typeof chatUserSchema>;

/**
 * What chat alone can say about a watcher. Whether they also have an account in
 * the room, and the emote that goes with it, is the tracker's to add: chat has
 * never heard of this room.
 */
export type ChatWatcher = Omit<Watcher, 'member' | 'emote'>;

export interface WatchedChannel {
  platform: WatchPlatform;
  /** Lowercase, as chat reports it. */
  id: string;
}

function isWatching(user: ChatUser, channel: WatchedChannel): boolean {
  const watching = user.watching;
  if (!watching) return false;
  return watching.platform === channel.platform && watching.id.toLowerCase() === channel.id;
}

function toWatcher(
  user: ChatUser,
  lastSpokeAt: string | null,
  lastEmote: string | null,
): ChatWatcher {
  return {
    nick: user.nick,
    flair: resolveFlair(user.features),
    subTier: user.subscription?.tier ?? null,
    lastSpokeAt,
    lastEmote,
  };
}

/**
 * Reads the emote out of a message, if there is one its author could use.
 * Answering null is the normal case — most messages are words — and is also
 * what a roster with no catalogue behind it does.
 */
export type EmoteReader = (text: string, subTier: number | null) => string | null;

const NO_EMOTES: EmoteReader = () => null;

/**
 * Who is watching one channel, kept from the chat event stream.
 *
 * Membership comes from the roster events; `lastSpokeAt` is kept across a
 * `NAMES` rebuild, because a reconnect does not mean nobody has spoken.
 */
export class WatcherRoster {
  private watchers = new Map<string, ChatWatcher>();

  constructor(
    private channel: WatchedChannel,
    private readonly readEmote: EmoteReader = NO_EMOTES,
  ) {}

  /**
   * A different channel shares nothing with the old one, so the roster starts
   * again. Answers whether it did, because an empty roster on a live socket
   * only refills as people speak.
   */
  watch(channel: WatchedChannel): boolean {
    if (channel.platform === this.channel.platform && channel.id === this.channel.id) return false;
    this.channel = channel;
    this.watchers.clear();
    return true;
  }

  clear(): void {
    this.watchers.clear();
  }

  size(): number {
    return this.watchers.size;
  }

  /** Whoever spoke most recently first, then everyone else. */
  list(): ChatWatcher[] {
    return [...this.watchers.values()].sort((left, right) => {
      const leftSpoke = left.lastSpokeAt ?? '';
      const rightSpoke = right.lastSpokeAt ?? '';
      if (leftSpoke === rightSpoke) return left.nick.localeCompare(right.nick);
      return leftSpoke < rightSpoke ? 1 : -1;
    });
  }

  apply(frame: ChatFrame, now: number = Date.now()): void {
    switch (frame.event) {
      case 'NAMES':
        return this.applyNames(frame.data);
      case 'HISTORY':
        return this.applyHistory(frame.data, now);
      case 'JOIN':
      case 'UPDATEUSER':
        return this.applyUser(frame.data, null);
      case 'MSG':
        return this.applyUser(frame.data, now);
      case 'QUIT':
        return this.applyQuit(frame.data);
      case 'USERSDELTA':
        return this.applyDelta(frame.data);
      default:
        return undefined;
    }
  }

  private applyNames(data: unknown): void {
    const parsed = z.object({ users: z.array(chatUserSchema) }).safeParse(data);
    if (!parsed.success) return;

    const rebuilt = new Map<string, ChatWatcher>();
    for (const user of parsed.data.users) {
      if (!isWatching(user, this.channel)) continue;
      const key = user.nick.toLowerCase();
      const known = this.watchers.get(key);
      rebuilt.set(key, toWatcher(user, known?.lastSpokeAt ?? null, known?.lastEmote ?? null));
    }
    this.watchers = rebuilt;
  }

  /**
   * The backlog chat sends on connect, as raw event strings. Applying it means
   * an overlay knows who has been talking the moment it connects, instead of
   * filling up over the next few minutes.
   */
  private applyHistory(data: unknown, now: number): void {
    const parsed = z.array(z.string()).safeParse(data);
    if (!parsed.success) return;
    for (const raw of parsed.data) {
      const frame = parseChatFrame(raw);
      if (frame && frame.event !== 'HISTORY') this.apply(frame, now);
    }
  }

  private applyUser(data: unknown, spokeAt: number | null): void {
    const parsed = chatUserSchema.safeParse(data);
    if (!parsed.success) return;
    const user = parsed.data;
    const key = user.nick.toLowerCase();

    if (!isWatching(user, this.channel)) {
      this.watchers.delete(key);
      return;
    }

    const known = this.watchers.get(key);
    const spokenAt =
      spokeAt === null
        ? (known?.lastSpokeAt ?? null)
        : new Date(user.timestamp ?? spokeAt).toISOString();
    // Only a message carries text, and only an emote in one replaces the last
    // one: a message of plain words leaves them as they were.
    const emote =
      (user.data === undefined ? null : this.readEmote(user.data, user.subscription?.tier ?? null)) ??
      known?.lastEmote ??
      null;
    this.watchers.set(key, toWatcher(user, spokenAt, emote));
  }

  private applyQuit(data: unknown): void {
    const parsed = z.object({ nick: z.string() }).safeParse(data);
    if (!parsed.success) return;
    this.watchers.delete(parsed.data.nick.toLowerCase());
  }

  private applyDelta(data: unknown): void {
    const parsed = z
      .object({
        users: z.array(chatUserSchema).default([]),
        removed: z.array(z.object({ nick: z.string() })).default([]),
      })
      .safeParse(data);
    if (!parsed.success) return;

    for (const user of parsed.data.users) this.applyUser(user, null);
    for (const gone of parsed.data.removed) this.applyQuit(gone);
  }
}

/** The chat socket and the roster it feeds. */
export class ChatTracker {
  private readonly roster: WatcherRoster;
  private socket: DggSocket | null = null;

  constructor(channel: WatchedChannel, readEmote?: EmoteReader) {
    this.roster = new WatcherRoster(channel, readEmote);
  }

  /**
   * Point at another channel. If the socket is up it is reconnected, because
   * `NAMES` is only sent on connect: carrying on with the same connection
   * would leave the roster empty and refill it one message at a time, which on
   * a quiet channel means naming almost nobody for several minutes.
   */
  watch(channel: WatchedChannel): void {
    if (!this.roster.watch(channel)) return;
    if (!this.socket) return;
    this.stop();
    this.start();
  }

  start(): void {
    if (this.socket) return;
    this.socket = new DggSocket({
      url: CHAT_SOCKET_URL,
      onFrame: (raw) => this.onFrame(raw),
    });
    this.socket.start();
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
    this.roster.clear();
  }

  get running(): boolean {
    return this.socket !== null;
  }

  state() {
    return this.socket?.state() ?? { connected: false, lastFrameAt: null, attempts: 0 };
  }

  watchers(): ChatWatcher[] {
    return this.roster.list();
  }

  count(): number {
    return this.roster.size();
  }

  private onFrame(raw: string): void {
    const frame = parseChatFrame(raw);
    if (!frame) return;
    // Rare, and separate from the protocol-level ping frames `ws` answers.
    if (frame.event === 'PING') {
      this.socket?.send(`PONG ${raw.slice('PING '.length)}`);
      return;
    }
    this.roster.apply(frame);
  }
}
