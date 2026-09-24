import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import {
  DggSocket,
  SILENCE_MS,
  goingAwayDelayMs,
  retryDelayMs,
  shouldTerminateForSilence,
} from './dgg-socket';

describe('retryDelayMs', () => {
  it('never retries back to back, and never waits longer than a minute', () => {
    for (const attempts of [1, 2, 5, 20]) {
      expect(retryDelayMs(attempts, () => 0)).toBe(500);
      expect(retryDelayMs(attempts, () => 0.999999)).toBeLessThanOrEqual(60_000);
    }
  });

  it('widens the window with each consecutive failure', () => {
    const nearlyOne = () => 0.999999;
    expect(retryDelayMs(1, nearlyOne)).toBeLessThan(retryDelayMs(2, nearlyOne));
    expect(retryDelayMs(2, nearlyOne)).toBeLessThan(retryDelayMs(3, nearlyOne));
  });

  it('caps the window rather than doubling forever', () => {
    const nearlyOne = () => 0.999999;
    expect(retryDelayMs(20, nearlyOne)).toBe(retryDelayMs(30, nearlyOne));
  });

  it('spreads attempts across the whole window rather than around a point', () => {
    // A mass disconnect releases every client at once; a narrow band would only
    // reschedule the stampede.
    expect(retryDelayMs(4, () => 0.1)).not.toBe(retryDelayMs(4, () => 0.9));
  });
});

describe('goingAwayDelayMs', () => {
  it('reconnects almost at once, but not at the same instant as everyone else', () => {
    expect(goingAwayDelayMs(() => 0)).toBe(0);
    expect(goingAwayDelayMs(() => 0.999)).toBeLessThan(1_000);
  });
});

describe('shouldTerminateForSilence', () => {
  const now = 1_000_000;
  const longAgo = now - SILENCE_MS * 10;

  it('replaces an open connection that has stopped sending anything', () => {
    // Both servers send protocol pings, so silence this long is not a lull.
    expect(shouldTerminateForSilence(WebSocket.OPEN, now - SILENCE_MS, now)).toBe(true);
  });

  it('leaves an open connection alone while it is still talking', () => {
    expect(shouldTerminateForSilence(WebSocket.OPEN, now - SILENCE_MS + 1, now)).toBe(false);
  });

  it('never terminates a connection that has not opened yet', () => {
    // The regression. `lastFrameAt` survives a reconnect, so after an outage it
    // is always older than SILENCE_MS by the time the next attempt begins.
    // Reading it alone killed every attempt on the first check five seconds in,
    // mid-handshake, which is how six days of DNS failure came to be logged as
    // "closed before the connection was established" instead of EAI_AGAIN.
    expect(shouldTerminateForSilence(WebSocket.CONNECTING, longAgo, now)).toBe(false);
  });

  it('leaves a closing or closed connection to its own close event', () => {
    expect(shouldTerminateForSilence(WebSocket.CLOSING, longAgo, now)).toBe(false);
    expect(shouldTerminateForSilence(WebSocket.CLOSED, longAgo, now)).toBe(false);
  });

  it('waits for a first frame before judging a connection quiet', () => {
    expect(shouldTerminateForSilence(WebSocket.OPEN, null, now)).toBe(false);
  });
});

describe('DggSocket', () => {
  it('reports when it went down, and clears that once it connects', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    const socket = new DggSocket({ url: `ws://127.0.0.1:${port}`, onFrame: () => undefined });
    socket.start();
    // Down from the moment it is wanted, so an outage is dated from the start
    // rather than from whenever somebody happened to look.
    expect(socket.state().downSince).not.toBeNull();

    await vi.waitFor(() => expect(socket.state().connected).toBe(true));
    expect(socket.state().downSince).toBeNull();

    socket.stop();
    await new Promise((resolve) => server.close(resolve));
  });

  it('survives being stopped while it is still connecting', async () => {
    // ws reports "closed before the connection was established" as an error
    // event. With no listener for it, Node throws it at the process: this took
    // the whole API down when a channel changed a moment after it connected.
    const socket = new DggSocket({ url: 'ws://127.0.0.1:1/nothing', onFrame: () => undefined });
    socket.start();
    socket.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.state().connected).toBe(false);
  });
});
