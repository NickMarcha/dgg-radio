/**
 * Watchers as bumper cars: everybody drifts at a steady pace, bounces off the
 * edges of the frame, and bounces off each other.
 *
 * Every other layout is CSS, because a path that repeats needs no per-frame
 * decision. This one cannot be: where a watcher goes next depends on where
 * everybody else is. So it is the one layout with a loop behind it, and the
 * step below is kept pure so it can be tested without a browser.
 *
 * Bodies are axis-aligned boxes rather than circles, because that is what an
 * emote with a name under it is, and a circle around one would leave a visible
 * gap before two of them touched.
 */

export interface BumperBody {
  nick: string;
  /** Top-left of the box, in pixels of the frame. */
  x: number;
  y: number;
  /** Pixels per second. */
  vx: number;
  vy: number;
  width: number;
  height: number;
}

export interface BumperBounds {
  width: number;
  height: number;
}

/** Pixels a second at `speed=100`, before a watcher's own variation. */
export const BUMPER_BASE_SPEED = 42;

/** A frame longer than this is a tab that was asleep, not a slow frame. */
const MAX_STEP_MS = 120;

function hash(nick: string): number {
  let value = 2166136261;
  for (let index = 0; index < nick.length; index += 1) {
    value ^= nick.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

/**
 * Where somebody starts, and how fast. Both come from their name, so a watcher
 * who leaves and comes back is not thrown across the frame.
 */
export function spawnBody(
  nick: string,
  bounds: BumperBounds,
  size: { width: number; height: number },
  speed: number,
): BumperBody {
  const seed = hash(nick);
  const free = {
    width: Math.max(1, bounds.width - size.width),
    height: Math.max(1, bounds.height - size.height),
  };
  // Every direction except the four diagonals-of-nothing: a body that starts
  // exactly horizontal never explores the frame until something hits it.
  const angle = ((seed >>> 8) % 360) * (Math.PI / 180);
  const pace = BUMPER_BASE_SPEED * (speed / 100) * (0.75 + ((seed >>> 20) % 50) / 100);

  return {
    nick,
    x: (seed % 1_000) / 1_000 * free.width,
    y: ((seed >>> 4) % 1_000) / 1_000 * free.height,
    vx: Math.cos(angle) * pace,
    vy: Math.sin(angle) * pace,
    width: size.width,
    height: size.height,
  };
}

function overlaps(a: BumperBody, b: BumperBody): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Two bodies that have run into each other trade the velocity along whichever
 * axis they overlap least, which is the axis they met on, and are pushed apart
 * by that overlap so the next frame does not read as another collision.
 */
function collide(a: BumperBody, b: BumperBody): void {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

  if (overlapX < overlapY) {
    const push = (overlapX / 2) * (a.x < b.x ? -1 : 1);
    a.x += push;
    b.x -= push;
    [a.vx, b.vx] = [b.vx, a.vx];
    return;
  }

  const push = (overlapY / 2) * (a.y < b.y ? -1 : 1);
  a.y += push;
  b.y -= push;
  [a.vy, b.vy] = [b.vy, a.vy];
}

/**
 * Advance everybody by `elapsedMs`. Mutates in place, because this runs on
 * every frame and a fresh array of a hundred objects a frame is litter.
 */
export function stepBumpers(
  bodies: BumperBody[],
  bounds: BumperBounds,
  elapsedMs: number,
): void {
  const seconds = Math.min(Math.max(elapsedMs, 0), MAX_STEP_MS) / 1_000;

  for (const body of bodies) {
    body.x += body.vx * seconds;
    body.y += body.vy * seconds;

    const right = Math.max(0, bounds.width - body.width);
    const bottom = Math.max(0, bounds.height - body.height);

    // Reflected and clamped in one go: a body that starts outside the frame,
    // because the window shrank or an emote loaded wider than it measured,
    // walks back in rather than sticking to the wall and inverting every frame.
    if (body.x < 0) {
      body.x = 0;
      body.vx = Math.abs(body.vx);
    } else if (body.x > right) {
      body.x = right;
      body.vx = -Math.abs(body.vx);
    }

    if (body.y < 0) {
      body.y = 0;
      body.vy = Math.abs(body.vy);
    } else if (body.y > bottom) {
      body.y = bottom;
      body.vy = -Math.abs(body.vy);
    }
  }

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      if (overlaps(bodies[i], bodies[j])) collide(bodies[i], bodies[j]);
    }
  }
}
