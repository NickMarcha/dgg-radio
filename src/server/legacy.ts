import { desc, lt, sql } from 'drizzle-orm';
import type { LegacyHistoryPage, LegacyPlay } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { legacyPlays } from './db/schema';

/**
 * Reading the room's QueUp history, which is an archive rather than part of the
 * room. `scripts/queup-import-room.ts` is the only thing that writes it, and
 * nothing in the live room reads it: the stats, profiles, rotation and repeat
 * cooldown all stay about what has happened here.
 */

/**
 * A link to the track's own page, where the provider's id is enough to build
 * one. QueUp stored SoundCloud tracks by numeric id, which names nothing
 * without asking SoundCloud, so those have no link until someone resolves them.
 */
function canonicalUrl(provider: LegacyPlay['provider'], providerMediaId: string): string | null {
  return provider === 'youtube' ? `https://www.youtube.com/watch?v=${providerMediaId}` : null;
}

/**
 * One page of the archive, newest first, walked by `before` rather than by an
 * offset: there are tens of thousands of rows and they never change, so a
 * cursor reads the same list however long someone spends on it.
 */
export async function listLegacyHistory(
  limit = 50,
  before: string | null = null,
  db: Database = getDatabase(),
): Promise<LegacyHistoryPage> {
  const cursor = before ? new Date(before) : null;
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(legacyPlays)
      .where(cursor ? lt(legacyPlays.playedAt, cursor) : undefined)
      .orderBy(desc(legacyPlays.playedAt))
      .limit(limit),
    db.select({ total: sql<number>`count(*)::int`.mapWith(Number) }).from(legacyPlays),
  ]);

  const entries: LegacyPlay[] = rows.map((row) => ({
    id: row.sourceId,
    provider: row.provider,
    title: row.title,
    canonicalUrl: canonicalUrl(row.provider, row.providerMediaId),
    durationSeconds: row.durationSeconds,
    thumbnailUrl: row.thumbnailUrl,
    requesterName: row.requesterName,
    playedAt: row.playedAt.toISOString(),
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    skipped: row.skipped,
  }));

  return {
    entries,
    total: counted?.total ?? 0,
    // A short page is the end of the archive; a full one may or may not be, and
    // the next request settles it.
    nextCursor: entries.length === limit ? (entries.at(-1)?.playedAt ?? null) : null,
  };
}
