import {
  and,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
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
  blockedMedia,
  media,
  moderationActions,
  queueItems,
  roomSettings,
  roomState,
  users,
  votes,
} from './db/schema';
import { lookupMediaCached } from './media-cache';
import { MediaLookupError, type MediaMetadata } from './media';
import { orderQueueRoundRobin } from './queue-order';

const ROOM_LOCK_ID = 1_349_922;
const MAX_QUEUED_PER_USER = 5;

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

interface QueueRow {
  id: string;
  status: QueueStatus;
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

async function queuedRows(db: Database): Promise<QueueRow[]> {
  const rows = await db
    .select(queueRowSelection())
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .where(eq(queueItems.status, 'queued'));
  return rows.map(toQueueRow);
}

async function nextQueuedRow(db: Database): Promise<QueueRow | null> {
  const ordered = orderQueueRoundRobin(
    (await queuedRows(db)).map((row) => ({
      ...row,
      requesterId: row.requestedBy.id,
    })),
  );
  return ordered[0] ?? null;
}

async function getSettings(db: Database) {
  await ensureRoomExists(db);
  const [settings] = await db
    .select({
      maxDurationSeconds: roomSettings.maxDurationSeconds,
      targetCountry: roomSettings.targetCountry,
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
  const [blocked] = await db
    .select({ reason: blockedMedia.reason })
    .from(blockedMedia)
    .where(
      and(
        eq(blockedMedia.provider, checked.provider),
        eq(blockedMedia.providerMediaId, checked.providerMediaId),
      ),
    )
    .limit(1);
  if (blocked) throw new RoomError('MEDIA_BLOCKED', `This track is blocked: ${blocked.reason}`);
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
    await transaction
      .update(queueItems)
      .set({ status, finishedAt: now, moderationReason: reason })
      .where(eq(queueItems.id, state.currentQueueItemId));
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

  const [blocked] = await db
    .select({ reason: blockedMedia.reason })
    .from(blockedMedia)
    .where(
      and(
        eq(blockedMedia.provider, metadata.provider),
        eq(blockedMedia.providerMediaId, metadata.providerMediaId),
      ),
    )
    .limit(1);
  if (blocked) throw new RoomError('MEDIA_BLOCKED', `This track is blocked: ${blocked.reason}`);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')));
  if (count >= MAX_QUEUED_PER_USER) {
    throw new RoomError('QUEUE_LIMIT', `You can have at most ${MAX_QUEUED_PER_USER} queued tracks.`);
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
        title: metadata.title,
        artist: metadata.artist,
        durationSeconds: metadata.durationSeconds,
        thumbnailUrl: metadata.thumbnailUrl,
      },
    })
    .returning({ id: media.id });
  if (!storedMedia) throw new RoomError('QUEUE_FAILED', 'The track could not be saved.', 500);

  const [item] = await db
    .insert(queueItems)
    .values({ mediaId: storedMedia.id, requestedByUserId: user.id })
    .returning({ id: queueItems.id });
  if (!item) throw new RoomError('QUEUE_FAILED', 'The request could not be queued.', 500);

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
  db: Database = getDatabase(),
): Promise<void> {
  const [item] = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .where(and(eq(queueItems.id, queueItemId), eq(queueItems.status, 'playing')))
    .limit(1);
  if (!item) throw new RoomError('NOT_PLAYING', 'Voting has closed for that track.');

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
    .returning({ id: queueItems.id });
  if (!removed) throw new RoomError('NOT_QUEUED', 'That track is no longer queued.');
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
  reason: string,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [item] = await db
    .select({
      mediaId: media.id,
      provider: media.provider,
      providerMediaId: media.providerMediaId,
      title: media.title,
      status: queueItems.status,
    })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(eq(queueItems.id, queueItemId))
    .limit(1);
  if (!item) throw new RoomError('QUEUE_ITEM_NOT_FOUND', 'That queue item does not exist.', 404);

  await db
    .insert(blockedMedia)
    .values({
      provider: item.provider,
      providerMediaId: item.providerMediaId,
      title: item.title,
      reason,
      blockedByUserId: admin.id,
    })
    .onConflictDoUpdate({
      target: [blockedMedia.provider, blockedMedia.providerMediaId],
      set: { reason, blockedByUserId: admin.id, createdAt: new Date() },
    });
  await db
    .update(queueItems)
    .set({ status: 'removed', finishedAt: new Date(), moderationReason: reason })
    .where(and(eq(queueItems.mediaId, item.mediaId), eq(queueItems.status, 'queued')));
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'block_media',
    queueItemId,
    mediaId: item.mediaId,
    details: { reason },
  });

  if (item.status === 'playing') {
    await advanceCurrentTrack('skipped', `Blocked: ${reason}`, queueItemId, db);
  } else {
    await bumpRevision(db);
  }
}

export async function updateRoomSettings(
  maxDurationSeconds: number,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  await db
    .update(roomSettings)
    .set({ maxDurationSeconds, updatedAt: new Date(), updatedByUserId: admin.id })
    .where(eq(roomSettings.id, 1));
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'update_settings',
    details: { maxDurationSeconds },
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
  const orderedQueue = orderQueueRoundRobin(
    activeRows
      .filter(({ status }) => status === 'queued')
      .map((row) => ({ ...row, requesterId: row.requestedBy.id })),
  );
  const hydrated = await queueWithVotes(
    [...(currentRow ? [currentRow] : []), ...orderedQueue],
    me?.id,
    db,
  );

  return {
    serverTime: new Date().toISOString(),
    revision: state.revision,
    listenerCount,
    settings: {
      maxDurationSeconds: settings.maxDurationSeconds,
      targetCountry: 'AE',
    },
    me: me
      ? {
          id: me.id,
          username: me.username,
          avatarUrl: me.avatarUrl,
          role: me.role,
          team: me.team,
        }
      : null,
    current: currentRow ? hydrated[0] ?? null : null,
    queue: currentRow ? hydrated.slice(1) : hydrated,
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
