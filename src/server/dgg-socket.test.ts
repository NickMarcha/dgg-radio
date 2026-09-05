import { describe, expect, it } from 'vitest';
import { DggSocket, goingAwayDelayMs, retryDelayMs } from './dgg-socket';

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

describe('DggSocket', () => {
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
