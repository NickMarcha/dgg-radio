import type { Context, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AuthenticatedUser } from './auth';

/**
 * A fixed window per caller. One API process holds every socket and the
 * playback clock, so a `Map` is the whole store: there is no second process to
 * share a count with. Counters are lost on restart, which costs nothing,
 * because a limit exists to stop a burst rather than to keep a ledger.
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Keeps the map from growing once a caller stops arriving. */
function sweep(now: number): void {
  if (windows.size < 1_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Whole seconds until the window resets, for `Retry-After`. */
  retryAfter: number;
}

export function consume(
  key: string,
  perMinute: number,
  now: number = Date.now(),
): RateLimitVerdict {
  sweep(now);
  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + 60_000 });
    return { allowed: true, retryAfter: 0 };
  }

  window.count += 1;
  if (window.count <= perMinute) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.ceil((window.resetAt - now) / 1_000) };
}

/** Only used by tests, which must not inherit counts from each other. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * The API publishes no port and answers nothing but the Cloudflare tunnel,
 * which sets `CF-Connecting-IP`. That is the only reason the header can be
 * believed here: on a directly reachable origin a caller could simply write
 * their own and be counted as somebody else.
 */
function callerAddress(context: Context): string {
  const forwarded = context.req.header('CF-Connecting-IP');
  if (forwarded) return forwarded;

  // `getConnInfo` throws where there is no Node server underneath. Deployed
  // traffic always carries the header above, so this only decides how an
  // unplaceable caller degrades: sharing one allowance is worse for them than
  // having their own, and far better than a route that fails outright.
  try {
    return getConnInfo(context).remote.address ?? 'unplaced';
  } catch {
    return 'unplaced';
  }
}

function refuse(context: Context, retryAfter: number) {
  context.header('Retry-After', String(retryAfter));
  return context.json(
    {
      error: {
        code: 'RATE_LIMITED',
        message: 'That is more requests than the room allows just now. Try again shortly.',
      },
    },
    429,
  );
}

/**
 * Counts against the signed-in user, so one person cannot spend a shared
 * resource for everybody. Must be placed after the guard that sets the user.
 */
export function limitPerUser(bucket: string, perMinute: number) {
  return async (context: Context, next: Next) => {
    const user = context.get('user') as AuthenticatedUser | undefined;
    // An unauthenticated caller never reaches here, and counting them all under
    // one key would let the first of them lock out the rest.
    if (!user) return next();

    const verdict = consume(`${bucket}:user:${user.id}`, perMinute);
    if (!verdict.allowed) return refuse(context, verdict.retryAfter);
    await next();
  };
}

/** Counts against the caller's address, for reads that need no account. */
export function limitPerAddress(bucket: string, perMinute: number) {
  return async (context: Context, next: Next) => {
    const verdict = consume(`${bucket}:ip:${callerAddress(context)}`, perMinute);
    if (!verdict.allowed) return refuse(context, verdict.retryAfter);
    await next();
  };
}
