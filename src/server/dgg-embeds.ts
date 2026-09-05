import { z } from 'zod';
import { DggSocket } from './dgg-socket';
import type { WatchedChannel } from './dgg-chat';

/**
 * The site-wide destiny.gg socket, read for one message type.
 *
 * `dggApi:embeds` arrives every 17 to 32 seconds as a complete list, and it
 * only carries embeds somebody is watching: a channel nobody has open is
 * absent, whatever the platform says about it being live. So this answers "the
 * site reported N people on it", and nothing stronger.
 */
export const LIVE_SOCKET_URL = 'wss://live.destiny.gg/';

const embedSchema = z.object({
  platform: z.string(),
  id: z.string(),
  count: z.number().int().nonnegative(),
  mediaItem: z
    .object({
      metadata: z
        .object({
          displayName: z.string().nullish(),
          title: z.string().nullish(),
          previewUrl: z.string().nullish(),
          live: z.boolean().nullish(),
          viewers: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const embedsFrameSchema = z.object({
  type: z.literal('dggApi:embeds'),
  data: z.array(embedSchema),
});

export interface EmbedEntry {
  platform: string;
  id: string;
  /** People with this embed open on destiny.gg. */
  count: number;
  displayName: string | null;
  title: string | null;
  previewUrl: string | null;
  /** What the platform itself reports for the whole stream, not the embed. */
  viewers: number | null;
}

/** The embed list from one frame, or null when the frame is any other type. */
export function parseEmbedsFrame(raw: string): EmbedEntry[] | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = embedsFrameSchema.safeParse(payload);
  if (!parsed.success) return null;

  return parsed.data.data.map((entry) => ({
    platform: entry.platform,
    id: entry.id,
    count: entry.count,
    displayName: entry.mediaItem?.metadata?.displayName ?? null,
    title: entry.mediaItem?.metadata?.title ?? null,
    previewUrl: entry.mediaItem?.metadata?.previewUrl ?? null,
    viewers: entry.mediaItem?.metadata?.viewers ?? null,
  }));
}

/** The entry for one channel, matched the way chat spells its ids. */
export function findEmbed(entries: EmbedEntry[], channel: WatchedChannel): EmbedEntry | null {
  return (
    entries.find(
      (entry) => entry.platform === channel.platform && entry.id.toLowerCase() === channel.id,
    ) ?? null
  );
}

export class EmbedsTracker {
  private socket: DggSocket | null = null;
  private entries: EmbedEntry[] = [];

  /** @param onUpdate called whenever a new embed list arrives, about twice a minute. */
  constructor(private readonly onUpdate: () => void = () => undefined) {}

  start(): void {
    if (this.socket) return;
    this.socket = new DggSocket({
      url: LIVE_SOCKET_URL,
      onFrame: (raw) => {
        const entries = parseEmbedsFrame(raw);
        if (!entries) return;
        this.entries = entries;
        this.onUpdate();
      },
    });
    this.socket.start();
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
    this.entries = [];
  }

  get running(): boolean {
    return this.socket !== null;
  }

  state() {
    return this.socket?.state() ?? { connected: false, lastFrameAt: null, attempts: 0 };
  }

  entryFor(channel: WatchedChannel): EmbedEntry | null {
    return findEmbed(this.entries, channel);
  }
}
