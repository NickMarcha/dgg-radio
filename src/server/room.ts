import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_IMPORT_TRACKS,
  type MediaProvider,
  type QueueItem,
  type QueueNotice,
  type RoomMedia,
  type RoomSnapshot,
  type RoomUser,
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
import { getEnv } from './env';
import { listJammers } from './community';
import { nowPlayingGenres } from './genre';
import {
  inspectManyCached,
  inspectMediaCached,
  lookupManyCached,
  lookupMediaCached,
} from './media-cache';
import { addRuleEntry, describeBlock, findBlockingRules, listActiveRules } from './rules';
import {
  listPlaylistTrackUrls,
  MediaLookupError,
  parsePlaylistUrl,
  type MediaMetadata,
} from './media';

const ROOM_LOCK_ID = 1_349_922;
/** A single import is capped so one link cannot bury the room in one person's queue. */

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
    providerArtistId: media.providerArtistId,
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
    requesterFlair: users.flair,
    requesterTopEmote: users.topEmote,
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
      providerArtistId: row.providerArtistId,
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
      flair: row.requesterFlair,
      topEmote: row.requesterTopEmote,
    },
  };
}

export async function ensureRoomExists(db: Database = getDatabase()): Promise<void> {
  await db.insert(roomSettings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(roomState).values({ id: 1 }).onConflictDoNothing();
}

async function bumpRevision(db: Executor): Promise<void> {
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
      description: roomSettings.description,
      maxDurationSeconds: roomSettings.maxDurationSeconds,
      repeatCooldownSeconds: roomSettings.repeatCooldownSeconds,
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

async function assertRepeatCooldownPassed(
  provider: MediaMetadata['provider'],
  providerMediaId: string,
  cooldownSeconds: number,
  db: Database,
  options: { excludeQueueItemId?: string; now?: Date } = {},
): Promise<void> {
  const conditions = [
    eq(media.provider, provider),
    eq(media.providerMediaId, providerMediaId),
    isNotNull(queueItems.startedAt),
  ];
  if (options.excludeQueueItemId) {
    conditions.push(ne(queueItems.id, options.excludeQueueItemId));
  }

  const [previous] = await db
    .select({ startedAt: queueItems.startedAt })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(and(...conditions))
    .orderBy(desc(queueItems.startedAt))
    .limit(1);
  if (!previous?.startedAt) return;

  const now = options.now ?? new Date();
  const elapsedMilliseconds = now.getTime() - previous.startedAt.getTime();
  const remainingMilliseconds = cooldownSeconds * 1_000 - elapsedMilliseconds;
  if (remainingMilliseconds <= 0) return;

  const elapsedMinutes = Math.floor(Math.max(0, elapsedMilliseconds) / 60_000);
  const elapsed =
    elapsedMinutes < 1
      ? 'less than a minute ago'
      : `${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} ago`;
  const remainingMinutes = Math.ceil(remainingMilliseconds / 60_000);
  throw new RoomError(
    'TRACK_RECENTLY_PLAYED',
    `That track played ${elapsed}. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
  );
}

async function validateForPlayback(
  candidate: QueueRow,
  maxDurationSeconds: number,
  repeatCooldownSeconds: number,
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
  const blocking = await findBlockingRules(checked, db);
  if (blocking.length > 0) {
    throw new RoomError('MEDIA_BLOCKED', `This track breaks ${describeBlock(blocking)}.`);
  }
  await assertRepeatCooldownPassed(
    checked.provider,
    checked.providerMediaId,
    repeatCooldownSeconds,
    db,
    { excludeQueueItemId: candidate.id },
  );
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
        settings.repeatCooldownSeconds,
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
          // The check writes its own message, so it is safe to hand straight
          // back to the person whose request it just dropped.
          listenerNotice: message,
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

/** Writes the freshest provider answer into `media` and hands back its row ID. */
async function storeMedia(metadata: MediaMetadata, db: Database): Promise<string> {
  const [stored] = await db
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
  if (!stored) throw new RoomError('QUEUE_FAILED', 'The track could not be saved.', 500);
  return stored.id;
}

/**
 * Turns a link into a stored `media` row for the personal playlist library.
 *
 * Saving is not admission, so this runs none of the room policy `enqueueMedia`
 * enforces: no duration limit, no blocklist, no repeat cooldown, no active
 * duplicate check. A track the room refuses today can still be kept and queued
 * once the room allows it. The provider lookup is the one step that cannot be
 * skipped, because an unknown link has no title, artist, or duration until a
 * provider answers for it.
 */
export async function resolveMediaForLibrary(
  url: string,
  db: Database = getDatabase(),
): Promise<string> {
  const settings = await getSettings(db);
  const { metadata } = await inspectMediaCached(url, settings.targetCountry, db);
  return storeMedia(metadata, db);
}

export interface LibraryTrack {
  url: string;
  title: string;
  /** Null when the provider refused the track; `reason` then says why. */
  mediaId: string | null;
  reason: string | null;
}

/**
 * Resolves every track inside a provider playlist for the personal library.
 * Like `resolveMediaForLibrary` it stores metadata and applies no room policy,
 * so a playlist holding blocked or overlong tracks still saves in full. A track
 * the provider itself refuses comes back with a reason instead of a media ID.
 */
export async function resolvePlaylistForLibrary(
  url: string,
  db: Database = getDatabase(),
): Promise<LibraryTrack[]> {
  const settings = await getSettings(db);
  const env = getEnv();
  const trackUrls = await listPlaylistTrackUrls(
    parsePlaylistUrl(url),
    { youtubeApiKey: env.YOUTUBE_API_KEY },
    MAX_PLAYLIST_TRACKS,
  );
  if (trackUrls.length === 0) {
    throw new RoomError('PLAYLIST_EMPTY', 'That playlist has no playable tracks.');
  }

  // One parallel warm-up, so the loop below only touches the database.
  const resolved = await inspectManyCached(trackUrls, settings.targetCountry, db);

  const tracks: LibraryTrack[] = [];
  for (const trackUrl of trackUrls) {
    const found = resolved.get(trackUrl);
    if (!found || found instanceof Error) {
      tracks.push({
        url: trackUrl,
        title: trackUrl,
        mediaId: null,
        reason: found?.message ?? 'Could not be read.',
      });
      continue;
    }
    tracks.push({
      url: trackUrl,
      title: found.metadata.title,
      mediaId: await storeMedia(found.metadata, db),
      reason: null,
    });
  }
  return tracks;
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

  const blocking = await findBlockingRules(metadata, db);
  if (blocking.length > 0) {
    const byArtist = blocking.find(({ entryType }) => entryType === 'artist');
    const scope = byArtist ? `${byArtist.label} is blocked` : 'That track is blocked';
    throw new RoomError('MEDIA_BLOCKED', `${scope} under ${describeBlock(blocking)}.`);
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

  await assertRepeatCooldownPassed(
    metadata.provider,
    metadata.providerMediaId,
    settings.repeatCooldownSeconds,
    db,
  );

  const storedMediaId = await storeMedia(metadata, db);

  const [{ nextPosition }] = await db
    .select({
      nextPosition: sql<number>`coalesce(max(${queueItems.position}), -1) + 1`.mapWith(Number),
    })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')));

  const [item] = await db
    .insert(queueItems)
    .values({ mediaId: storedMediaId, requestedByUserId: user.id, position: nextPosition })
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

export interface PlaylistImport {
  added: number;
  skipped: { title: string; reason: string }[];
}

/**
 * Adds a whole playlist to the caller's own queue. Every track still goes
 * through the normal request path, so a blocked or overlong one is reported
 * rather than quietly let in.
 */
export async function enqueueProviderPlaylist(
  url: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<PlaylistImport> {
  const settings = await getSettings(db);
  const env = getEnv();
  const parsed = parsePlaylistUrl(url);
  const trackUrls = await listPlaylistTrackUrls(
    parsed,
    { youtubeApiKey: env.YOUTUBE_API_KEY },
    MAX_QUEUE_IMPORT_TRACKS,
  );
  if (trackUrls.length === 0) {
    throw new RoomError('PLAYLIST_EMPTY', 'That playlist has no playable tracks.');
  }

  // Warm the cache in parallel first; the requests below then only touch the database.
  const resolved = await lookupManyCached(trackUrls, settings.targetCountry, db);

  const result: PlaylistImport = { added: 0, skipped: [] };
  for (const trackUrl of trackUrls) {
    const found = resolved.get(trackUrl);
    const label = found instanceof Error || !found ? trackUrl : found.title;
    if (found instanceof Error || !found) {
      result.skipped.push({ title: label, reason: found?.message ?? 'Could not be read.' });
      continue;
    }
    try {
      await enqueueMedia(trackUrl, user, db);
      result.added += 1;
    } catch (error) {
      result.skipped.push({
        title: label,
        reason: error instanceof Error ? error.message : 'Could not be queued.',
      });
    }
  }
  return result;
}

export async function voteOnCurrentTrack(
  queueItemId: string,
  value: -1 | 0 | 1,
  user: AuthenticatedUser,
  eligibleVoterCount: number,
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

  if (value === -1 && (await downvotesForceSkip(queueItemId, eligibleVoterCount, db))) {
    await advanceCurrentTrack('skipped', 'Skipped by room vote.', queueItemId, db);
  }
}

/**
 * Whether the room has voted a track off. In ratio mode the bar moves with the
 * audience, and a room with nobody in it can never reach it.
 */
async function downvotesForceSkip(
  queueItemId: string,
  eligibleVoterCount: number,
  db: Database,
): Promise<boolean> {
  const settings = await getSettings(db);
  const [{ downvotes }] = await db
    .select({ downvotes: sql<number>`count(*)`.mapWith(Number) })
    .from(votes)
    .where(and(eq(votes.queueItemId, queueItemId), eq(votes.value, -1)));

  if (settings.skipMode === 'absolute') return downvotes >= settings.skipDownvotes;
  if (eligibleVoterCount < 1) return false;
  return (downvotes * 100) / eligibleVoterCount >= settings.skipRatioPercent;
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

function orderedRoomQueueRows(activeRows: QueueRow[], currentQueueItemId: string | null): QueueRow[] {
  const currentRow = activeRows.find(({ id }) => id === currentQueueItemId);
  const currentRequesterId = currentRow?.requestedBy.id;
  const seatOf = (row: QueueRow) =>
    row.requestedBy.id === currentRequesterId
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

  const seen = new Set<string>();
  return queuedRows.filter(({ requestedBy }) => {
    if (seen.has(requestedBy.id)) return false;
    seen.add(requestedBy.id);
    return true;
  });
}

/** Reorders the DJ rotation shown in the room queue without changing personal queues. */
export async function reorderRoomQueue(
  orderedIds: string[],
  moderator: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  await ensureRoomExists(db);
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${ROOM_LOCK_ID})`);
    const [state] = await transaction
      .select({ currentQueueItemId: roomState.currentQueueItemId })
      .from(roomState)
      .where(eq(roomState.id, 1));
    const activeRows = await transaction
      .select(queueRowSelection())
      .from(queueItems)
      .innerJoin(media, eq(queueItems.mediaId, media.id))
      .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
      .where(inArray(queueItems.status, ['queued', 'playing']))
      .then((rows) => rows.map(toQueueRow));
    const roomRows = orderedRoomQueueRows(activeRows, state?.currentQueueItemId ?? null);
    const byId = new Map(roomRows.map((row) => [row.id, row]));

    if (orderedIds.length !== roomRows.length || orderedIds.some((id) => !byId.has(id))) {
      throw new RoomError('QUEUE_CHANGED', 'The room queue changed. Try the move again.', 409);
    }

    const currentRequesterId = activeRows.find(({ id }) => id === state?.currentQueueItemId)?.requestedBy.id;
    const currentRequesterRow = roomRows.find(({ requestedBy }) => requestedBy.id === currentRequesterId);
    if (currentRequesterRow && orderedIds.at(-1) !== currentRequesterRow.id) {
      throw new RoomError(
        'CURRENT_DJ_LOCKED',
        "The current DJ's next turn must stay at the bottom until this track ends.",
      );
    }

    for (const id of orderedIds) {
      const row = byId.get(id)!;
      await transaction
        .update(users)
        .set({ rotationSeq: sql`nextval('dj_rotation_seq')` })
        .where(eq(users.id, row.requestedBy.id));
    }
    await transaction.insert(moderationActions).values({
      actorUserId: moderator.id,
      action: 'reorder_room_queue',
      details: { orderedIds },
    });
    await bumpRevision(transaction);
  });
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
  moderator: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [state] = await db
    .select({ currentQueueItemId: roomState.currentQueueItemId })
    .from(roomState)
    .where(eq(roomState.id, 1));
  if (!state?.currentQueueItemId) throw new RoomError('NOTHING_PLAYING', 'There is no track to skip.');

  await db.insert(moderationActions).values({
    actorUserId: moderator.id,
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

/**
 * A listener taking back one of their own tracks before it plays. Unlike a
 * moderator removal this records no moderation action: there is nothing to
 * answer for. The track they are currently playing is not theirs to pull.
 */
/**
 * Clearing the notice is how it is marked read: the room only ever needs to
 * know whether it still owes this person an explanation.
 */
export async function dismissQueueNotice(
  queueItemId: string,
  owner: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [cleared] = await db
    .update(queueItems)
    .set({ listenerNotice: null })
    .where(
      and(
        eq(queueItems.id, queueItemId),
        eq(queueItems.requestedByUserId, owner.id),
        isNotNull(queueItems.listenerNotice),
      ),
    )
    .returning({ id: queueItems.id });
  if (!cleared) {
    throw new RoomError('NOTICE_NOT_FOUND', 'There is no unread notice of yours with that id.', 404);
  }
}

async function listMyNotices(userId: string, db: Database): Promise<QueueNotice[]> {
  const rows = await db
    .select({
      queueItemId: queueItems.id,
      message: queueItems.listenerNotice,
      removedAt: queueItems.finishedAt,
      title: media.title,
      artist: media.artist,
    })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(and(eq(queueItems.requestedByUserId, userId), isNotNull(queueItems.listenerNotice)))
    .orderBy(desc(queueItems.finishedAt));

  return rows.map((row) => ({
    queueItemId: row.queueItemId,
    title: row.title,
    artist: row.artist,
    message: row.message ?? '',
    removedAt: (row.removedAt ?? new Date()).toISOString(),
  }));
}

export async function withdrawQueuedTrack(
  queueItemId: string,
  owner: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [withdrawn] = await db
    .update(queueItems)
    .set({ status: 'removed', finishedAt: new Date() })
    .where(
      and(
        eq(queueItems.id, queueItemId),
        eq(queueItems.status, 'queued'),
        eq(queueItems.requestedByUserId, owner.id),
      ),
    )
    .returning({ id: queueItems.id });
  if (!withdrawn) {
    throw new RoomError(
      'NOT_YOUR_QUEUED_TRACK',
      'That track is not one of yours waiting to play.',
      404,
    );
  }
  if (!(await hasQueuedTracks(owner.id, db))) {
    await db.update(users).set({ rotationSeq: null }).where(eq(users.id, owner.id));
  }
  await bumpRevision(db);
}

/** What is being blocked, however somebody arrived at it. */
interface BlockTarget {
  provider: MediaProvider;
  entryType: 'track' | 'artist';
  /** The id the entry is keyed by: one track, or everything by one artist. */
  providerId: string;
  /** What a reader sees on the list. */
  label: string;
  /** The row this came from, where the room has one. */
  mediaId?: string | null;
  /** The request this came from, where a request is what prompted it. */
  queueItemId?: string | null;
}

/**
 * The part of blocking that is the same whether a moderator blocked the track
 * playing now or an admin pasted a link: write the entry under every rule
 * named, drop everything already queued that the entry now covers, and record
 * what was done.
 */
async function applyBlock(
  target: BlockTarget,
  options: { ruleIds: string[]; note?: string | null },
  moderator: AuthenticatedUser,
  db: Database,
): Promise<{ removed: number }> {
  if (options.ruleIds.length === 0) {
    throw new RoomError('NO_RULE_GIVEN', 'Choose at least one rule to block this under.');
  }

  const blockingArtist = target.entryType === 'artist';
  for (const ruleId of options.ruleIds) {
    await addRuleEntry(
      ruleId,
      {
        provider: target.provider,
        entryType: target.entryType,
        providerId: target.providerId,
        label: target.label,
        note: options.note ?? null,
      },
      moderator,
      db,
    );
  }

  // Everything the new entry now covers, not only whatever prompted it.
  const covered = and(
    eq(media.provider, target.provider),
    blockingArtist
      ? eq(media.providerArtistId, target.providerId)
      : eq(media.providerMediaId, target.providerId),
  );
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
    actorUserId: moderator.id,
    action: blockingArtist ? 'block_artist' : 'block_track',
    queueItemId: target.queueItemId ?? null,
    mediaId: target.mediaId ?? null,
    details: { ruleIds: options.ruleIds, note: options.note ?? null },
  });

  return { removed: doomed.length };
}

export async function blockQueueItemMedia(
  queueItemId: string,
  options: { ruleIds: string[]; entryType: 'track' | 'artist'; note?: string | null },
  moderator: AuthenticatedUser,
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
  await applyBlock(
    {
      provider: item.provider,
      entryType: options.entryType,
      providerId: blockingArtist ? item.providerArtistId : item.providerMediaId,
      label: blockingArtist ? item.artist : item.title,
      mediaId: item.mediaId,
      queueItemId,
    },
    options,
    moderator,
    db,
  );

  if (item.status === 'playing') {
    await advanceCurrentTrack('skipped', 'Blocked by a room rule.', queueItemId, db);
  } else {
    await bumpRevision(db);
  }
}

/**
 * Blocking something nobody has requested yet.
 *
 * A link is read the same way a request is, so an admin can block a track, or
 * everything by whoever published it, before it ever reaches the room. Nothing
 * is added to `media` on the way: a track the room has never played does not
 * need a row here just to be refused, and the entry is keyed by the provider's
 * own id either way.
 *
 * On YouTube the artist is the channel; on SoundCloud it is the account that
 * uploaded the track. Both are what that provider hangs a catalogue off.
 */
export async function blockMediaByUrl(
  url: string,
  options: { ruleIds: string[]; entryType: 'track' | 'artist'; note?: string | null },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<{ label: string; removed: number }> {
  const settings = await getSettings(db);
  const { metadata } = await inspectMediaCached(url, settings.targetCountry, db);
  const blockingArtist = options.entryType === 'artist';

  // A row only if the room happens to have one, so the log can point at it.
  const [known] = await db
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.provider, metadata.provider),
        eq(media.providerMediaId, metadata.providerMediaId),
      ),
    )
    .limit(1);

  const label = blockingArtist ? metadata.artist : metadata.title;
  const { removed } = await applyBlock(
    {
      provider: metadata.provider,
      entryType: options.entryType,
      providerId: blockingArtist ? metadata.providerArtistId : metadata.providerMediaId,
      label,
      mediaId: known?.id ?? null,
    },
    options,
    admin,
    db,
  );

  await bumpRevision(db);
  return { label, removed };
}

export type RoomSettingsPatch = Partial<{
  description: string;
  maxDurationSeconds: number;
  repeatCooldownSeconds: number;
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

export async function getRoomSnapshot(
  me: AuthenticatedUser | null,
  listenerCount: number,
  db: Database = getDatabase(),
): Promise<RoomSnapshot> {
  await ensureRoomExists(db);
  if (me) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, me.id));
  }

  const [state, settings, activeRows, stats, rules, myNotices] = await Promise.all([
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
    listJammers(10, undefined, db),
    listActiveRules(db),
    me ? listMyNotices(me.id, db) : [],
  ]);

  if (!state) throw new RoomError('ROOM_NOT_READY', 'The room has not been initialized.', 500);
  const currentRow = activeRows.find(({ id }) => id === state.currentQueueItemId) ?? null;

  // The room queue is one track per person: what each of them plays on their
  // next turn, in the order the room will reach them.
  const roomQueueRows = orderedRoomQueueRows(activeRows, state.currentQueueItemId);
  const queuedRows = activeRows
    .filter(({ status }) => status === 'queued')
    .sort(
      (left, right) =>
        left.position - right.position || left.requestedAt.getTime() - right.requestedAt.getTime(),
    );
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
   * comes back as the track runs out, and mods and admins always see it.
   */
  const secondsLeft =
    current?.startedAt && current.media.durationSeconds
      ? (new Date(current.startedAt).getTime() + current.media.durationSeconds * 1_000 - Date.now()) /
        1_000
      : Number.POSITIVE_INFINITY;
  const privileged = me?.role === 'admin' || me?.role === 'mod';
  const censor = !settings.revealRequester && !privileged;
  const hide = <T extends { id: string; requestedBy: RoomUser | null }>(item: T, reveal: boolean): T =>
    censor && !reveal && item.requestedBy?.id !== me?.id ? { ...item, requestedBy: null } : item;

  return {
    serverTime: new Date().toISOString(),
    revision: state.revision,
    listenerCount,
    settings,
    me: toRoomUser(me),
    current: current ? hide(current, secondsLeft <= REVEAL_REQUESTER_WITHIN_SECONDS) : null,
    currentGenres: current
      ? nowPlayingGenres(
          { provider: current.media.provider, providerMediaId: current.media.providerMediaId },
          current.media.title,
          current.media.artist,
          db,
        )
      : null,
    queue: roomQueueRows.map((row) => hide(byId.get(row.id)!, false)),
    myQueue: myQueueRows.map((row) => byId.get(row.id)!),
    myNotices,
    selectorStats: stats,
    rules,
  };
}

/** The public view of a signed-in listener: no Destiny tokens, roles, or features. */
export function toRoomUser(user: AuthenticatedUser | null): RoomUser | null {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    flair: user.flair,
    topEmote: user.topEmote,
    role: user.role,
    team: user.team,
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
