import { desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDatabase, type Database } from './db/client';
import { media, moderationActions, queueItems, users } from './db/schema';
import type { ModerationEntry, ModerationLog } from '../shared/contracts';

/** Blocking records the media directly; skipping and removing reach it through the queue item. */
const queuedMedia = alias(media, 'queued_media');
const blockedMedia = alias(media, 'blocked_media');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A reason is written under different keys depending on what was done, and a
 * blocked track carries a note rather than a reason. The log reads better with
 * one field for "why", so it is picked out here and the rest of the record is
 * handed over untouched.
 */
function reasonFrom(details: Record<string, unknown>): string | null {
  for (const key of ['reason', 'note']) {
    const value = details[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Clearing a queue names its target by id, which is no use to read. */
function targetId(details: Record<string, unknown>): string | null {
  const value = details.userId;
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

export async function getModerationLog(
  limit = 100,
  db: Database = getDatabase(),
): Promise<ModerationLog> {
  const rows = await db
    .select({
      id: moderationActions.id,
      action: moderationActions.action,
      details: moderationActions.details,
      createdAt: moderationActions.createdAt,
      actor: users.username,
      queuedTitle: queuedMedia.title,
      queuedArtist: queuedMedia.artist,
      blockedTitle: blockedMedia.title,
      blockedArtist: blockedMedia.artist,
    })
    .from(moderationActions)
    .innerJoin(users, eq(moderationActions.actorUserId, users.id))
    .leftJoin(queueItems, eq(moderationActions.queueItemId, queueItems.id))
    .leftJoin(queuedMedia, eq(queueItems.mediaId, queuedMedia.id))
    .leftJoin(blockedMedia, eq(moderationActions.mediaId, blockedMedia.id))
    .orderBy(desc(moderationActions.createdAt))
    .limit(limit);

  // One lookup for every target on the page, rather than a join through JSON
  // that a value of the wrong shape would break.
  const targetIds = [...new Set(rows.map((row) => targetId(row.details)).filter((id) => id !== null))];
  const targets = targetIds.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, targetIds))
    : [];
  const usernames = new Map(targets.map(({ id, username }) => [id, username]));

  const entries: ModerationEntry[] = rows.map((row) => {
    const title = row.queuedTitle ?? row.blockedTitle;
    const artist = row.queuedArtist ?? row.blockedArtist;
    const target = targetId(row.details);
    return {
      id: row.id,
      actor: row.actor,
      action: row.action,
      track: title ? { title, artist: artist ?? '' } : null,
      target: target ? usernames.get(target) ?? null : null,
      reason: reasonFrom(row.details),
      details: row.details,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return { capturedAt: new Date().toISOString(), entries };
}
