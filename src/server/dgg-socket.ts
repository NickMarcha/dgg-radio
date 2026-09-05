import { WebSocket } from 'ws';
import type { WatchSocketState } from '../shared/contracts';

/**
 * One reconnecting client for both destiny.gg sockets.
 *
 * It sends no `Origin` header. Both sockets answer 403 to an origin that is not
 * destiny.gg's own and accept a request carrying none at all, which is also why
 * this cannot run in a browser: a page always sends its own origin and cannot
 * be told not to. Claiming to be destiny.gg would work and is not what this is.
 *
 * The backoff below is chat-gui's, from `assets/chat/js/source.js`, because it
 * encodes problems already met against these servers rather than guessed at.
 */
const USER_AGENT = 'dgg-radio (+https://github.com/NickMarcha/dgg-radio)';

/**
 * How long a socket must stay open before the connection counts as healthy. The
 * backend completes the WebSocket handshake before it authenticates, so a
 * connection it then rejects fires `open` first; without this, such a
 * connection would reset the backoff and be retried forever at the shortest
 * interval.
 */
export const STABLE_CONNECTION_MS = 5_000;

const RETRY_WINDOW_MS = 3_000;
const RETRY_WINDOW_CAP_MS = 60_000;
const RETRY_MIN_MS = 500;

/**
 * Spread for a Going Away reconnect. Cloudflare cycling a server closes every
 * client on it at the same instant, so a fast retry still needs jitter.
 */
const GOING_AWAY_SPREAD_MS = 1_000;

/**
 * Both servers send protocol-level ping frames — chat every 10 seconds, the
 * live socket every 30 — which `ws` answers by itself. That makes silence a
 * reliable signal rather than a guess: half a minute without a frame of any
 * kind means the connection is gone, whatever it claims about its state.
 */
export const SILENCE_MS = 30_000;

const SILENCE_CHECK_MS = 5_000;

/**
 * Full jitter over a window that doubles with each consecutive failed attempt.
 * The jitter matters as much as the backoff: a mass disconnect releases every
 * client at once, and a fixed retry band only reschedules the stampede.
 */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const windowMs = Math.min(RETRY_WINDOW_CAP_MS, RETRY_WINDOW_MS * 2 ** attempts);
  return RETRY_MIN_MS + Math.floor(random() * (windowMs - RETRY_MIN_MS));
}

/** Close code 1001 from a healthy connection is routine, so it retries almost at once. */
export function goingAwayDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * GOING_AWAY_SPREAD_MS);
}

/**
 * Stop listening to a socket being discarded.
 *
 * The error sink is the point. Closing a socket that is still connecting makes
 * `ws` emit `error`, and an EventEmitter with no error listener throws it at
 * the process — so dropping every listener and then closing takes the server
 * down. Nothing wants the report any more; it just has to go somewhere.
 */
function silence(socket: WebSocket): void {
  socket.removeAllListeners();
  socket.on('error', () => undefined);
}

export interface DggSocketOptions {
  url: string;
  /** Every text frame, exactly as it arrived. */
  onFrame: (raw: string) => void;
  /** Called after each successful open, for whatever has to be re-established. */
  onOpen?: () => void;
}

export class DggSocket {
  private socket: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private connectedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private attempts = 0;
  private wanted = false;

  constructor(private readonly options: DggSocketOptions) {}

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.clearTimers();
    this.connectedAt = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      silence(socket);
      socket.close(1000, 'No longer needed');
    }
  }

  send(raw: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(raw);
  }

  state(): WatchSocketState {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      lastFrameAt: this.lastFrameAt === null ? null : new Date(this.lastFrameAt).toISOString(),
      attempts: this.attempts,
    };
  }

  private connect(): void {
    this.attempts += 1;
    this.connectedAt = null;
    const socket = new WebSocket(this.options.url, { headers: { 'User-Agent': USER_AGENT } });
    this.socket = socket;

    socket.on('open', () => {
      this.connectedAt = Date.now();
      this.touch();
      this.options.onOpen?.();
    });
    socket.on('message', (data) => {
      this.touch();
      this.options.onFrame(data.toString());
    });
    // A control frame is not a message, but it is proof the connection is alive.
    socket.on('ping', () => this.touch());
    socket.on('pong', () => this.touch());
    socket.on('error', (error) => console.error(`${this.options.url} failed`, error.message));
    socket.on('close', (code) => this.onClose(code));

    this.startSilenceWatch();
  }

  private onClose(code: number): void {
    if (this.socket) silence(this.socket);
    this.socket = null;
    this.clearTimers();
    if (!this.wanted) return;

    const stable =
      this.connectedAt !== null && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS;
    this.connectedAt = null;
    if (stable) this.attempts = 0;

    const delay = code === 1001 && stable ? goingAwayDelayMs() : retryDelayMs(this.attempts);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private touch(): void {
    this.lastFrameAt = Date.now();
  }

  private startSilenceWatch(): void {
    this.silenceTimer = setInterval(() => {
      if (this.lastFrameAt === null || Date.now() - this.lastFrameAt < SILENCE_MS) return;
      console.warn(`${this.options.url} went quiet, reconnecting`);
      // terminate rather than close: a socket this quiet will not answer a
      // closing handshake either, and close would wait for one.
      this.socket?.terminate();
    }, SILENCE_CHECK_MS);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.retryTimer = null;
    this.silenceTimer = null;
  }
}
