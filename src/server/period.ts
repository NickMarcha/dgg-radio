import { and, gte, lt, type Column, type SQL } from 'drizzle-orm';
import type { StatsPeriod } from '../shared/contracts';

/**
 * Narrowing the stats to a year or a month.
 *
 * Everything is bounded in UTC, which is what the timestamps are stored in.
 * A room whose listeners are spread across time zones has no local midnight to
 * prefer, and a month that means something different depending on who is asking
 * is worse than one that is an hour off somebody's idea of it.
 *
 * A month without a year means nothing, so it is ignored rather than guessed at.
 */
export function periodRange(period: StatsPeriod): { from: Date; to: Date } | null {
  if (period.year === null) return null;
  if (period.month === null) {
    return {
      from: new Date(Date.UTC(period.year, 0, 1)),
      to: new Date(Date.UTC(period.year + 1, 0, 1)),
    };
  }
  return {
    from: new Date(Date.UTC(period.year, period.month - 1, 1)),
    to: new Date(Date.UTC(period.year, period.month, 1)),
  };
}

/**
 * The same range as a condition on whichever column dates the row. Undefined
 * when nothing is being narrowed, so it drops out of an `and` untouched.
 */
export function withinPeriod(column: Column, period: StatsPeriod): SQL | undefined {
  const range = periodRange(period);
  if (!range) return undefined;
  return and(gte(column, range.from), lt(column, range.to));
}

/** Every stat is about all of time until somebody says otherwise. */
export const ALL_TIME: StatsPeriod = { year: null, month: null };
