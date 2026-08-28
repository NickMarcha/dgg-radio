import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type {
  QueueItem,
  RoomMedia,
  RoomSnapshot,
  RoomUser,
  SelectorStats,
} from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import {
  media,
  moderationActions,
  queueItems,
  roomSettings,
  roomState,
  users,
  votes,
} from './db/schema';
import { lookupMediaCached } from './media-cache';
import { addRuleEntry, findBlockingRule } from './rules';
import { MediaLookupError, type MediaMetadata } from './media';

const ROOM_LOCK_ID = 1_349_922;
/** How close to the end a track must be before a hidden requester is revealed. */
const REVEAL_REQUESTER_WITHIN_SECONDS = 15;

export class RoomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

type QueueStatus = QueueItem['status'];

/** Either the pool or an open transaction on it. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

interface QueueRow {
  id: string;
  status: QueueStatus;
  position: number;
  rotationSeq: number | null;
  requestedAt: Date;
  startedAt: Date | null;
  requesterLastPlayedAt: Date | null;
  media: RoomMedia;
  requestedBy: RoomUser;
}

function queueRowSelection() {
  return {
    id: queueItems.id,
    status: queueItems.status,
    position: queueItems.position,
    rotationSeq: users.rotationSeq,
    requestedAt: queueItems.requestedAt,
    startedAt: queueItems.startedAt,
    requesterLastPlayedAt: users.lastPlayedAt,
    mediaId: media.id,
    provider: media.provider,
    providerMediaId: media.providerMediaId,
    canonicalUrl: media.canonicalUrl,
    title: media.title,
    artist: media.artist,
    durationSeconds: media.durationSeconds,
    thumbnailUrl: media.thumbnailUrl,
    requesterId: users.id,
    requesterUsername: users.username,
    requesterAvatarUrl: users.avatarUrl,
    requesterRole: users.role,
    requesterTeam: users.team,
  };
}

function toQueueRow(row: ReturnType<typeof queueRowSelection> extends never ? never : any): QueueRow {
  return {
    id: row.id,
    status: row.status,
    position: row.position,
    rotationSeq: row.rotationSeq,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    requesterLastPlayedAt: row.requesterLastPlayedAt,
    media: {
      id: row.mediaId,
      provider: row.provider,
      providerMediaId: row.providerMediaId,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      artist: row.artist,
      durationSeconds: row.durationSeconds,
      thumbnailUrl: row.thumbnailUrl,
    },
    requestedBy: {
      id: row.requesterId,
      username: row.requesterUsername,
      avatarUrl: row.requesterAvatarUrl,
      role: row.requesterRole,
      team: row.requesterTeam,
    },
  };
}

export async function ensureRoomExists(db: Database = getDatabase()): Promise<void> {
  await db.insert(roomSettings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(roomState).values({ id: 1 }).onConflictDoNothing();
}

async function bumpRevision(db: Database): Promise<void> {
  await db
    .update(roomState)
    .set({ revision: sql`${roomState.revision} + 1`, updatedAt: new Date() })
    .where(eq(roomState.id, 1));
}

/** The first track of whoever is at the front of the rotation. */
async function nextQueuedRow(db: Database): Promise<QueueRow | null> {
  const [row] = await db
    .select(queueRowSelection())
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .where(and(eq(queueItems.status, 'queued'), isNotNull(users.rotationSeq)))
    .orderBy(asc(users.rotationSeq), asc(queueItems.position), asc(queueItems.requestedAt))
    .limit(1);
  return row ? toQueueRow(row) : null;
}

async function hasQueuedTracks(userId: string, db: Executor): Promise<boolean> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, userId), eq(queueItems.status, 'queued')));
  return count > 0;
}

/** Joins the back of the rotation, unless already waiting somewhere in it. */
async function joinRotation(userId: string, db: Executor): Promise<void> {
  await db
    .update(users)
    .set({ rotationSeq: sql`nextval('dj_rotation_seq')` })
    .where(and(eq(users.id, userId), isNull(users.rotationSeq)));
}

/**
 * Called once a person's track is done with. They go to the back if they still
 * have something queued, and otherwise leave the rotation until they queue again.
 */
async function cycleRotation(userId: string, db: Executor): Promise<void> {
  const stillQueued = await hasQueuedTracks(userId, db);
  await db
    .update(users)
    .set({ rotationSeq: stillQueued ? sql`nextval('dj_rotation_seq')` : null })
    .where(eq(users.id, userId));
}

async function getSettings(db: Database) {
  await ensureRoomExists(db);
  const [settings] = await db
    .select({
      maxDurationSeconds: roomSettings.maxDurationSeconds,
      targetCountry: roomSettings.targetCountry,
      skipMode: roomSettings.skipMode,
      skipDownvotes: roomSettings.skipDownvotes,
      skipRatioPercent: roomSettings.skipRatioPercent,
      revealRequester: roomSettings.revealRequester,
    })
    .from(roomSettings)
    .where(eq(roomSettings.id, 1));
  if (!settings) throw new RoomError('ROOM_NOT_READY', 'The room has not been initialized.', 500);
  return settings;
}

async function validateForPlayback(
  candidate: QueueRow,
  maxDurationSeconds: number,
  targetCountry: string,
  db: Database,
): Promise<MediaMetadata> {
  const checked = await lookupMediaCached(candidate.media.canonicalUrl, targetCountry, db);
  if (checked.durationSeconds > maxDurationSeconds) {
    throw new RoomError(
      'TRACK_TOO_LONG',
      `Tracks must be ${Math.floor(maxDurationSeconds / 60)} minutes or shorter.`,
    );
  }
  const blocked = await findBlockingRule(checked, db);
  if (blocked) throw new RoomError('MEDIA_BLOCKED', `This track breaks "${blocked.ruleName}".`);
  return checked;
}

export async function startNextTrack(db: Database = getDatabase()): Promise<boolean> {
  const settings = await getSettings(db);

  for (;;) {
    const [state] = await db
      .select({ currentQueueItemId: roomState.currentQueueItemId })
      .from(roomState)
      .where(eq(roomState.id, 1));
    if (state?.currentQueueItemId) return false;

    const candidate = await nextQueuedRow(db);
    if (!candidate) return false;

    let checked: MediaMetadata;
    try {
      checked = await validateForPlayback(
        candidate,
        settings.maxDurationSeconds,
        settings.targetCountry,
        db,
      );
    } catch (error) {
      if (error instanceof MediaLookupError && error.status >= 500) return false;
      const message = error instanceof Error ? error.message : 'Automatic playback check failed.';
      await db
        .update(queueItems)
        .set({
          status: 'removed',
          finishedAt: new Date(),
          moderationReason: `Automatic playback check: ${message}`,
        })
        .where(and(eq(queueItems.id, candidate.id), eq(queueItems.status, 'queued')));
      await bumpRevision(db);
      continue;
    }

    const started = await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${ROOM_LOCK_ID})`);
      const [lockedState] = await transaction
        .select({ currentQueueItemId: roomState.currentQueueItemId })
        .from(roomState)
        .where(eq(roomState.id, 1));
      if (lockedState?.currentQueueItemId) return false;

      const now = new Date();
      const [claimed] = await transaction
        .update(queueItems)
        .set({ status: 'playing', startedAt: now })
        .where(and(eq(queueItems.id, candidate.id), eq(queueItems.status, 'queued')))
        .returning({ id: queueItems.id });
      if (!claimed) return false;

      await transaction
        .update(media)
        .set({
          providerArtistId: checked.providerArtistId,
          title: checked.title,
          artist: checked.artist,
          durationSeconds: checked.durationSeconds,
          thumbnailUrl: checked.thumbnailUrl,
        })
        .where(eq(media.id, candidate.media.id));
      await transaction
        .update(users)
        .set({ lastPlayedAt: now })
        .where(eq(users.id, candidate.requestedBy.id));
      await transaction
        .update(roomState)
        .set({
          currentQueueItemId: candidate.id,
          revision: sql`${roomState.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(roomState.id, 1));
      return true;
    });
    return started;
  }
}

export async function advanceCurrentTrack(
  status: 'played' | 'skipped',
  reason: string | null,
  expectedQueueItemId?: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  await ensureRoomExists(db);
  const advanced = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${ROOM_LOCK_ID})`);
    const [state] = await transaction
      .select({ currentQueueItemId: roomState.currentQueueItemId })
      .from(roomState)
      .where(eq(roomState.id, 1));
    if (!state?.currentQueueItemId) return false;
    if (expectedQueueItemId && state.currentQueueItemId !== expectedQueueItemId) return false;

    const now = new Date();
    const [finished] = await transaction
      .update(queueItems)
      .set({ status, finishedAt: now, moderationReason: reason })
      .where(eq(queueItems.id, state.currentQueueItemId))
      .returning({ requestedByUserId: queueItems.requestedByUserId });
    if (finished) await cycleRotation(finished.requestedByUserId, transaction);
    await transaction
      .update(roomState)
      .set({
        currentQueueItemId: null,
        revision: sql`${roomState.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(roomState.id, 1));
    return true;
  });

  if (advanced) await startNextTrack(db);
  return advanced;
}

export async function advanceIfExpired(db: Database = getDatabase()): Promise<boolean> {
  const [current] = await db
    .select({
      id: queueItems.id,
      startedAt: queueItems.startedAt,
      durationSeconds: media.durationSeconds,
    })
    .from(roomState)
    .innerJoin(queueItems, eq(roomState.currentQueueItemId, queueItems.id))
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(eq(roomState.id, 1));

  if (!current?.startedAt) {
    return startNextTrack(db);
  }
  const endsAt = current.startedAt.getTime() + current.durationSeconds * 1_000;
  return Date.now() >= endsAt
    ? advanceCurrentTrack('played', null, current.id, db)
    : false;
}

export async function enqueueMedia(
  url: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<{ id: string; provider: 'youtube' | 'soundcloud'; durationSeconds: number }> {
  const settings = await getSettings(db);
  const metadata = await lookupMediaCached(url, settings.targetCountry, db);

  if (metadata.durationSeconds > settings.maxDurationSeconds) {
    throw new RoomError(
      'TRACK_TOO_LONG',
      `Tracks must be ${Math.floor(settings.maxDurationSeconds / 60)} minutes or shorter.`,
    );
  }

  const blocked = await findBlockingRule(metadata, db);
  if (blocked) {
    const scope = blocked.entryType === 'artist' ? `${blocked.label} is blocked` : 'That track is blocked';
    throw new RoomError('MEDIA_BLOCKED', `${scope} under "${blocked.ruleName}".`);
  }

  const [activeDuplicate] = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(
      and(
        eq(media.provider, metadata.provider),
        eq(media.providerMediaId, metadata.providerMediaId),
        inArray(queueItems.status, ['queued', 'playing']),
      ),
    )
    .limit(1);
  if (activeDuplicate) throw new RoomError('ALREADY_QUEUED', 'That track is already in the room queue.');

  const [storedMedia] = await db
    .insert(media)
    .values(metadata)
    .onConflictDoUpdate({
      target: [media.provider, media.providerMediaId],
      set: {
        canonicalUrl: metadata.canonicalUrl,
        providerArtistId: metadata.providerArtistId,
        title: metadata.title,
        artist: metadata.artist,
        durationSeconds: metadata.durationSeconds,
        thumbnailUrl: metadata.thumbnailUrl,
      },
    })
    .returning({ id: media.id });
  if (!storedMedia) throw new RoomError('QUEUE_FAILED', 'The track could not be saved.', 500);

  const [{ nextPosition }] = await db
    .select({
      nextPosition: sql<number>`coalesce(max(${queueItems.position}), -1) + 1`.mapWith(Number),
    })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')));

  const [item] = await db
    .insert(queueItems)
    .values({ mediaId: storedMedia.id, requestedByUserId: user.id, position: nextPosition })
    .returning({ id: queueItems.id });
  if (!item) throw new RoomError('QUEUE_FAILED', 'The request could not be queued.', 500);

  await joinRotation(user.id, db);
  await bumpRevision(db);
  await startNextTrack(db);
  return {
    id: item.id,
    provider: metadata.provider,
    durationSeconds: metadata.durationSeconds,
  };
}

export async function voteOnCurrentTrack(
  queueItemId: string,
  value: -1 | 0 | 1,
  user: AuthenticatedUser,
  listenerCount: number,
  db: Database = getDatabase(),
): Promise<void> {
  const [item] = await db
    .select({ id: queueItems.id, requestedByUserId: queueItems.requestedByUserId })
    .from(queueItems)
    .where(and(eq(queueItems.id, queueItemId), eq(queueItems.status, 'playing')))
    .limit(1);
  if (!item) throw new RoomError('NOT_PLAYING', 'Voting has closed for that track.');
  if (item.requestedByUserId === user.id) {
    throw new RoomError('OWN_TRACK', 'You cannot vote on your own request.');
  }

  if (value === 0) {
    await db
      .delete(votes)
      .where(and(eq(votes.queueItemId, queueItemId), eq(votes.userId, user.id)));
  } else {
    await db
      .insert(votes)
      .values({ queueItemId, userId: user.id, value })
      .onConflictDoUpdate({
        target: [votes.queueItemId, votes.userId],
        set: { value, updatedAt: new Date() },
      });
  }
  await bumpRevision(db);

  if (value === -1 && (await downvotesForceSkip(queueItemId, listenerCount, db))) {
    await advanceCurrentTrack('skipped', 'Skipped by room vote.', queueItemId, db);
  }
}

/**
 * Whether the room has voted a track off. In ratio mode the bar moves with the
 * audience, and a room with nobody in it can never reach it.
 */
async function downvotesForceSkip(
  queueItemId: string,
  listenerCount: number,
  db: Database,
): Promise<boolean> {
  const settings = await getSettings(db);
  const [{ downvotes }] = await db
    .select({ downvotes: sql<number>`count(*)`.mapWith(Number) })
    .from(votes)
    .where(and(eq(votes.queueItemId, queueItemId), eq(votes.value, -1)));

  if (settings.skipMode === 'absolute') return downvotes >= settings.skipDownvotes;
  if (listenerCount < 1) return false;
  return (downvotes * 100) / listenerCount >= settings.skipRatioPercent;
}

/**
 * Rewrites the caller's own ordering. Ids not given keep their relative order
 * behind the ones that were, so a partial list cannot lose tracks.
 */
export async function reorderMyQueue(
  orderedIds: string[],
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const mine = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')))
    .orderBy(asc(queueItems.position));

  const owned = new Set(mine.map(({ id }) => id));
  const unknown = orderedIds.find((id) => !owned.has(id));
  if (unknown) throw new RoomError('NOT_YOUR_TRACK', 'That track is not in your queue.');

  const ordered = [...orderedIds, ...mine.map(({ id }) => id).filter((id) => !orderedIds.includes(id))];
  await db.transaction(async (transaction) => {
    for (const [position, id] of ordered.entries()) {
      await transaction.update(queueItems).set({ position }).where(eq(queueItems.id, id));
    }
  });
  await bumpRevision(db);
}

/** Admin action: drop everything a person has waiting and take them out of the rotation. */
export async function clearUserQueue(
  userId: string,
  reason: string,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<number> {
  const cleared = await db
    .update(queueItems)
    .set({ status: 'removed', finishedAt: new Date(), moderationReason: reason })
    .where(and(eq(queueItems.requestedByUserId, userId), eq(queueItems.status, 'queued')))
    .returning({ id: queueItems.id });

  await db.update(users).set({ rotationSeq: null }).where(eq(users.id, userId));
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'clear_queue',
    details: { userId, reason, removed: cleared.length },
  });
  await bumpRevision(db);
  return cleared.length;
}

export async function skipCurrentTrack(
  reason: string,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [state] = await db
    .select({ currentQueueItemId: roomState.currentQueueItemId })
    .from(roomState)
    .where(eq(roomState.id, 1));
  if (!state?.currentQueueItemId) throw new RoomError('NOTHING_PLAYING', 'There is no track to skip.');

  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'skip',
    queueItemId: state.currentQueueItemId,
    details: { reason },
  });
  await advanceCurrentTrack('skipped', reason, state.currentQueueItemId, db);
}

export async function removeQueuedTrack(
  queueItemId: string,
  reason: string,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [removed] = await db
    .update(queueItems)
    .set({ status: 'removed', finishedAt: new Date(), moderationReason: reason })
    .where(and(eq(queueItems.id, queueItemId), eq(queueItems.status, 'queued')))
    .returning({ id: queueItems.id, requestedByUserId: queueItems.requestedByUserId });
  if (!removed) throw new RoomError('NOT_QUEUED', 'That track is no longer queued.');
  if (!(await hasQueuedTracks(removed.requestedByUserId, db))) {
    await db.update(users).set({ rotationSeq: null }).where(eq(users.id, removed.requestedByUserId));
  }
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'remove',
    queueItemId,
    details: { reason },
  });
  await bumpRevision(db);
}

export async function blockQueueItemMedia(
  queueItemId: string,
  options: { ruleId: string; entryType: 'track' | 'artist'; note?: string | null },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [item] = await db
    .select({
      mediaId: media.id,
      provider: media.provider,
      providerMediaId: media.providerMediaId,
      providerArtistId: media.providerArtistId,
      title: media.title,
      artist: media.artist,
      status: queueItems.status,
    })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(eq(queueItems.id, queueItemId))
    .limit(1);
  if (!item) throw new RoomError('QUEUE_ITEM_NOT_FOUND', 'That queue item does not exist.', 404);

  const blockingArtist = options.entryType === 'artist';
  await addRuleEntry(
    options.ruleId,
    {
      provider: item.provider,
      entryType: options.entryType,
      providerId: blockingArtist ? item.providerArtistId : item.providerMediaId,
      label: blockingArtist ? item.artist : item.title,
      note: options.note ?? null,
    },
    admin,
    db,
  );

  // Drop everything the new entry now covers, not just the item that triggered it.
  const covered = blockingArtist
    ? and(eq(media.provider, item.provider), eq(media.providerArtistId, item.providerArtistId))
    : eq(queueItems.mediaId, item.mediaId);
  const doomed = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(and(eq(queueItems.status, 'queued'), covered));
  if (doomed.length > 0) {
    await db
      .update(queueItems)
      .set({
        status: 'removed',
        finishedAt: new Date(),
        moderationReason: options.note ?? 'Blocked by a room rule.',
      })
      .where(inArray(queueItems.id, doomed.map(({ id }) => id)));
  }

  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: blockingArtist ? 'block_artist' : 'block_track',
    queueItemId,
    mediaId: item.mediaId,
    details: { ruleId: options.ruleId, note: options.note ?? null },
  });

  if (item.status === 'playing') {
    await advanceCurrentTrack('skipped', 'Blocked by a room rule.', queueItemId, db);
  } else {
    await bumpRevision(db);
  }
}

export type RoomSettingsPatch = Partial<{
  maxDurationSeconds: number;
  targetCountry: string;
  skipMode: 'absolute' | 'ratio';
  skipDownvotes: number;
  skipRatioPercent: number;
  revealRequester: boolean;
}>;

export async function updateRoomSettings(
  patch: RoomSettingsPatch,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  if (Object.keys(patch).length === 0) {
    throw new RoomError('NO_SETTINGS_GIVEN', 'No settings were provided.');
  }
  await db
    .update(roomSettings)
    .set({ ...patch, updatedAt: new Date(), updatedByUserId: admin.id })
    .where(eq(roomSettings.id, 1));
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'update_settings',
    details: patch,
  });
  await bumpRevision(db);
}

async function queueWithVotes(
  rows: QueueRow[],
  currentUserId: string | undefined,
  db: Database,
): Promise<QueueItem[]> {
  if (rows.length === 0) return [];
  const itemIds = rows.map(({ id }) => id);
  const voteRows = await db
    .select({ queueItemId: votes.queueItemId, userId: votes.userId, value: votes.value })
    .from(votes)
    .where(inArray(votes.queueItemId, itemIds));

  return rows.map((row) => {
    const itemVotes = voteRows.filter(({ queueItemId }) => queueItemId === row.id);
    return {
      id: row.id,
      media: row.media,
      requestedBy: row.requestedBy,
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      upvotes: itemVotes.filter(({ value }) => value === 1).length,
      downvotes: itemVotes.filter(({ value }) => value === -1).length,
      myVote: (itemVotes.find(({ userId }) => userId === currentUserId)?.value ?? 0) as -1 | 0 | 1,
    };
  });
}

async function selectorStats(db: Database): Promise<SelectorStats[]> {
  const scoreExpression = sql<number>`coalesce(sum(${votes.value}), 0)`.mapWith(Number);
  const rows = await db
    .select({
      userId: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      team: users.team,
      plays: countDistinct(queueItems.id).mapWith(Number),
      upvotes: sql<number>`count(*) filter (where ${votes.value} = 1)`.mapWith(Number),
      downvotes: sql<number>`count(*) filter (where ${votes.value} = -1)`.mapWith(Number),
      score: scoreExpression,
    })
    .from(queueItems)
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .leftJoin(votes, eq(queueItems.id, votes.queueItemId))
    .where(isNotNull(queueItems.startedAt))
    .groupBy(users.id, users.username, users.avatarUrl, users.role, users.team)
    .orderBy(desc(scoreExpression), desc(countDistinct(queueItems.id)))
    .limit(10);

  return rows.map((row) => ({
    user: {
      id: row.userId,
      username: row.username,
      avatarUrl: row.avatarUrl,
      role: row.role,
      team: row.team,
    },
    plays: row.plays,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
  }));
}

export async function getRoomSnapshot(
  me: AuthenticatedUser | null,
  listenerCount: number,
  db: Database = getDatabase(),
): Promise<RoomSnapshot> {
  await ensureRoomExists(db);
  if (me) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, me.id));
  }

  const [state, settings, activeRows, stats] = await Promise.all([
    db
      .select({ revision: roomState.revision, currentQueueItemId: roomState.currentQueueItemId })
      .from(roomState)
      .where(eq(roomState.id, 1))
      .then(([row]) => row),
    getSettings(db),
    db
      .select(queueRowSelection())
      .from(queueItems)
      .innerJoin(media, eq(queueItems.mediaId, media.id))
      .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
      .where(inArray(queueItems.status, ['queued', 'playing']))
      .then((rows) => rows.map(toQueueRow)),
    selectorStats(db),
  ]);

  if (!state) throw new RoomError('ROOM_NOT_READY', 'The room has not been initialized.', 500);
  const currentRow = activeRows.find(({ id }) => id === state.currentQueueItemId) ?? null;

  const playingRequesterId = currentRow?.requestedBy.id;
  const seatOf = (row: QueueRow) =>
    row.requestedBy.id === playingRequesterId
      ? Number.MAX_SAFE_INTEGER
      : row.rotationSeq ?? Number.MAX_SAFE_INTEGER - 1;
  const queuedRows = activeRows
    .filter(({ status }) => status === 'queued')
    .sort(
      (left, right) =>
        seatOf(left) - seatOf(right) ||
        left.position - right.position ||
        left.requestedAt.getTime() - right.requestedAt.getTime(),
    );

  // The room queue is one track per person: what each of them plays on their
  // next turn, in the order the room will reach them.
  const seen = new Set<string>();
  const roomQueueRows = queuedRows.filter(({ requestedBy }) => {
    if (seen.has(requestedBy.id)) return false;
    seen.add(requestedBy.id);
    return true;
  });
  const myQueueRows = me ? queuedRows.filter(({ requestedBy }) => requestedBy.id === me.id) : [];

  const hydrated = await queueWithVotes(
    [...(currentRow ? [currentRow] : []), ...roomQueueRows, ...myQueueRows],
    me?.id,
    db,
  );
  const byId = new Map(hydrated.map((item) => [item.id, item]));
  const current = currentRow ? byId.get(currentRow.id) ?? null : null;

  /**
   * With the requester hidden, votes are cast on the track alone. The name
   * comes back as the track runs out, and admins always see it.
   */
  const secondsLeft =
    current?.startedAt && current.media.durationSeconds
      ? (new Date(current.startedAt).getTime() + current.media.durationSeconds * 1_000 - Date.now()) /
        1_000
      : Number.POSITIVE_INFINITY;
  const privileged = me?.role === 'admin';
  const censor = !settings.revealRequester && !privileged;
  const hide = <T extends { id: string; requestedBy: RoomUser | null }>(item: T, reveal: boolean): T =>
    censor && !reveal && item.requestedBy?.id !== me?.id ? { ...item, requestedBy: null } : item;

  return {
    serverTime: new Date().toISOString(),
    revision: state.revision,
    listenerCount,
    settings,
    me: me
      ? {
          id: me.id,
          username: me.username,
          avatarUrl: me.avatarUrl,
          role: me.role,
          team: me.team,
        }
      : null,
    current: current ? hide(current, secondsLeft <= REVEAL_REQUESTER_WITHIN_SECONDS) : null,
    queue: roomQueueRows.map((row) => hide(byId.get(row.id)!, false)),
    myQueue: myQueueRows.map((row) => byId.get(row.id)!),
    selectorStats: stats,
  };
}

export async function currentRevision(db: Database = getDatabase()): Promise<number> {
  await ensureRoomExists(db);
  const [state] = await db
    .select({ revision: roomState.revision })
    .from(roomState)
    .where(eq(roomState.id, 1));
  return state?.revision ?? 0;
}
