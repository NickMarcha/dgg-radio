// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchersSnapshot } from '../shared/contracts';
import WatchersOverlay from './WatchersOverlay';

/**
 * The bumper layout is the one that moves things itself, so this is about the
 * wiring rather than the physics: that the loop starts, measures, and writes a
 * position onto each watcher, and stops when the layout changes. What the
 * positions should be is `bumperMotion.test.ts`.
 */

const state = vi.hoisted(() => ({ snapshot: null as WatchersSnapshot | null }));
vi.mock('./useWatchers', () => ({ useWatchers: () => state.snapshot }));

const frames: FrameRequestCallback[] = [];
let clock = 0;
let reducedMotion = false;

function runFrame(elapsedMs = 16): void {
  clock += elapsedMs;
  const due = frames.splice(0, frames.length);
  for (const callback of due) callback(clock);
}

function snapshot(nicks: string[]): WatchersSnapshot {
  return {
    channel: { platform: 'kick', id: 'destiny' },
    live: true,
    siteCount: nicks.length,
    chatCount: nicks.length,
    watchers: nicks.map((nick) => ({
      nick,
      flair: null,
      subTier: null,
      lastSpokeAt: new Date().toISOString(),
      lastEmote: null,
      member: false,
      emote: null,
    })),
  };
}

beforeEach(() => {
  clock = 0;
  frames.length = 0;
  reducedMotion = false;
  // The overlay reads its options out of the address bar, so the layout under
  // test has to be in it.
  window.history.replaceState({}, '', '/embed/watchers?layout=bump');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0, frames.length));
  // jsdom has no matchMedia at all, so the reduced-motion question needs an answer.
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: reducedMotion }));
  // jsdom lays nothing out, so the frame and the watchers need a size to bounce in.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 80,
    height: 50,
    top: 0,
    left: 0,
    right: 80,
    bottom: 50,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  for (const property of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get: () => (property === 'clientWidth' ? 1_920 : 1_080),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.snapshot = null;
});

function positions(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.watcher')].map(
    (element) => element.style.translate,
  );
}

describe('the bumper layout', () => {
  it('puts everybody somewhere inside the frame and then moves them', () => {
    state.snapshot = snapshot(['anpan', 'Strumpling', 'x35']);
    render(<WatchersOverlay apiUrl="http://api.test" />);

    runFrame();
    const placed = positions();
    expect(placed).toHaveLength(3);
    expect(placed.every((value) => /^-?\d+px -?\d+px$/.test(value))).toBe(true);

    for (let i = 0; i < 20; i += 1) runFrame(16);
    expect(positions()).not.toEqual(placed);
  });

  it('keeps everybody within the frame, minus the edge inset', () => {
    state.snapshot = snapshot(['anpan', 'Strumpling', 'x35', 'Evelynn']);
    render(<WatchersOverlay apiUrl="http://api.test" />);

    for (let i = 0; i < 200; i += 1) runFrame(16);

    for (const value of positions()) {
      const [x, y] = value.split(' ').map(Number.parseFloat);
      // 4% of 1920 and of 1080, with the watcher's own 80 × 50 box inside it.
      expect(x).toBeGreaterThanOrEqual(1_920 * 0.04 - 1);
      expect(x).toBeLessThanOrEqual(1_920 * 0.96 - 80 + 1);
      expect(y).toBeGreaterThanOrEqual(1_080 * 0.04 - 1);
      expect(y).toBeLessThanOrEqual(1_080 * 0.96 - 50 + 1);
    }
  });

  it('holds still for somebody who asked for less motion', () => {
    // Every other layout is stopped by the stylesheet. This one has to stop
    // itself, because its motion is not a stylesheet's to stop.
    reducedMotion = true;
    state.snapshot = snapshot(['anpan', 'Strumpling']);
    render(<WatchersOverlay apiUrl="http://api.test" />);

    for (let i = 0; i < 30; i += 1) runFrame(16);
    expect(positions().every((value) => value === '')).toBe(true);
  });

  it('leaves the other layouts to the stylesheet', () => {
    state.snapshot = snapshot(['anpan', 'Strumpling']);
    window.history.replaceState({}, '', '/embed/watchers?layout=float');
    render(<WatchersOverlay apiUrl="http://api.test" />);

    for (let i = 0; i < 5; i += 1) runFrame(16);
    expect(positions().every((value) => value === '')).toBe(true);
  });
});
