import { describe, expect, it } from 'vitest';
import {
  BUMPER_BASE_SPEED,
  spawnBody,
  stepBumpers,
  type BumperBody,
} from './bumperMotion';

const BOUNDS = { width: 1_000, height: 500 };

function body(nick: string, over: Partial<BumperBody> = {}): BumperBody {
  return { nick, x: 0, y: 0, vx: 0, vy: 0, width: 60, height: 40, ...over };
}

describe('a watcher bouncing around the frame', () => {
  it('moves at its own velocity', () => {
    const one = body('a', { x: 100, y: 100, vx: 60, vy: -30 });
    stepBumpers([one], BOUNDS, 100);
    expect(one.x).toBeCloseTo(106, 10);
    expect(one.y).toBeCloseTo(97, 10);
  });

  it('turns around at every wall and stays inside the frame', () => {
    // Kept apart from each other, so the only thing they meet is a wall.
    const left = body('a', { x: 5, y: 200, vx: -100 });
    const right = body('b', { x: 930, y: 200, vx: 100 });
    const top = body('c', { x: 400, y: 5, vy: -100 });
    const bottom = body('d', { x: 400, y: 450, vy: 100 });
    stepBumpers([left, right, top, bottom], BOUNDS, 200);

    expect(left.x).toBe(0);
    expect(left.vx).toBeGreaterThan(0);
    expect(right.x).toBe(BOUNDS.width - right.width);
    expect(right.vx).toBeLessThan(0);
    expect(top.y).toBe(0);
    expect(top.vy).toBeGreaterThan(0);
    expect(bottom.y).toBe(BOUNDS.height - bottom.height);
    expect(bottom.vy).toBeLessThan(0);
  });

  it('walks a body the window left outside back in rather than pinning it', () => {
    const stranded = body('a', { x: 4_000, y: 3_000, vx: 50, vy: 50 });
    stepBumpers([stranded], BOUNDS, 16);

    expect(stranded.x).toBe(BOUNDS.width - stranded.width);
    expect(stranded.y).toBe(BOUNDS.height - stranded.height);
    expect(stranded.vx).toBeLessThan(0);
    expect(stranded.vy).toBeLessThan(0);
  });

  it('ignores the gap left by a sleeping tab instead of teleporting', () => {
    const one = body('a', { x: 100, vx: 100 });
    stepBumpers([one], BOUNDS, 60_000);
    expect(one.x).toBeLessThanOrEqual(100 + 100 * 0.12);
  });
});

describe('two watchers running into each other', () => {
  it('trades the velocity along the axis they met on', () => {
    const left = body('a', { x: 100, y: 100, vx: 50 });
    const right = body('b', { x: 155, y: 100, vx: -20 });
    stepBumpers([left, right], BOUNDS, 0);

    expect(left.vx).toBe(-20);
    expect(right.vx).toBe(50);
  });

  it('separates them, so the next frame is not another collision', () => {
    const upper = body('a', { x: 100, y: 100, vy: 40 });
    const lower = body('b', { x: 100, y: 130, vy: -40 });
    stepBumpers([upper, lower], BOUNDS, 0);

    expect(lower.y - upper.y).toBeGreaterThanOrEqual(upper.height);
    expect(upper.vy).toBe(-40);
    expect(lower.vy).toBe(40);
  });

  it('leaves two that are merely near each other alone', () => {
    const one = body('a', { x: 100, y: 100, vx: 30 });
    const other = body('b', { x: 200, y: 100, vx: -30 });
    stepBumpers([one, other], BOUNDS, 0);

    expect(one.vx).toBe(30);
    expect(other.vx).toBe(-30);
  });
});

describe('where a watcher starts', () => {
  const size = { width: 60, height: 40 };

  it('is the same every time for the same name', () => {
    const first = spawnBody('Cake', BOUNDS, size, 100);
    const second = spawnBody('Cake', BOUNDS, size, 100);
    expect(second).toEqual(first);
  });

  it('is inside the frame, and different for somebody else', () => {
    const one = spawnBody('Cake', BOUNDS, size, 100);
    const other = spawnBody('Bread', BOUNDS, size, 100);

    expect(one.x).toBeGreaterThanOrEqual(0);
    expect(one.x).toBeLessThanOrEqual(BOUNDS.width - size.width);
    expect(one.y).toBeGreaterThanOrEqual(0);
    expect(one.y).toBeLessThanOrEqual(BOUNDS.height - size.height);
    expect(other.x).not.toBe(one.x);
  });

  it('scales with the chosen speed', () => {
    const paceOf = (body: BumperBody) => Math.hypot(body.vx, body.vy);
    const normal = paceOf(spawnBody('Cake', BOUNDS, size, 100));
    const double = paceOf(spawnBody('Cake', BOUNDS, size, 200));

    expect(double).toBeCloseTo(normal * 2, 5);
    expect(normal).toBeGreaterThan(BUMPER_BASE_SPEED * 0.5);
    expect(normal).toBeLessThan(BUMPER_BASE_SPEED * 1.5);
  });
});
