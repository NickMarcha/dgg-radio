import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from 'drizzle-orm';
import {
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_IMPORT_TRACKS,
  type MediaProvider,
  type QueueItem,
  type QueueMovePlan,
  type QueueNotice,
  type StationMedia,
  type StationSnapshot,
  type StationUser,
} from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import {
  media,
  moderationActions,
  queueItems,
  stations,
  stationSeats,
  stationSettings,
  stationState,
  users,
  votes,
} from './db/schema';
import { getEnv } from './env';
import { listJammers } from './community';
import { enrichTrack } from './enrichment';
import { nowPlayingGenres } from './genre';
import {
  inspectManyCached,
  inspectMediaCached,
  lookupManyCached,
  lookupMediaCached,
} from './media-cache';
import { MAIN_STATION_ID, stationRoleOf } from './stations';
import {
  addRuleEntry,
  assertRulesInStation,
  describeBlock,
  findBlockingRules,
  listActiveRules,
} from './rules';
import {
  listPlaylistTrackUrls,
  MediaLookupError,
  parsePlaylistUrl,
  type MediaMetadata,
} from './media';

const STATION_LOCK_ID = 1_349_922;
/** A single import is capped so one link cannot bury the station in one person's queue. */

/** How close to the end a track must be before a hidden requester is revealed. */
const REVEAL_REQUESTER_WITHIN_SECONDS = 15;

export class StationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'StationError';
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
  media: StationMedia;
  requestedBy: StationUser;
}

function queueRowSelection() {
  return {
    id: queueItems.id,
    status: queueItems.status,
    position: queueItems.position,
    rotationSeq: stationSeats.seq,
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

export async function ensureStationExists(stationId: string, db: Database = getDatabase()): Promise<void> {
  await db.insert(stationSettings).values({ stationId }).onConflictDoNothing();
  await db.insert(stationState).values({ stationId }).onConflictDoNothing();
}

/** Every station, for the clock to tick. There are few enough to visit each second. */
export async function listStationIds(db: Database = getDatabase()): Promise<string[]> {
  const rows = await db.select({ stationId: stationState.stationId }).from(stationState);
  return rows.map(({ stationId }) => stationId);
}

async function bumpRevision(stationId: string, db: Executor): Promise<void> {
  await db
    .update(stationState)
    .set({ revision: sql`${stationState.revision} + 1`, updatedAt: new Date() })
    .where(eq(stationState.stationId, stationId));
}

/**
 * Serialises queue transitions within one station. Stations never wait on each
 * other, so the lock is keyed by the station as well as by this module.
 */
async function lockStation(stationId: string, transaction: Executor): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(${STATION_LOCK_ID}, hashtext(${stationId}))`);
}

/** A queue item joined to its track, its requester, and their seat in its station. */
function selectQueueRows(db: Executor) {
  return db
    .select(queueRowSelection())
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .leftJoin(
      stationSeats,
      and(eq(stationSeats.userId, queueItems.requestedByUserId), eq(stationSeats.stationId, queueItems.stationId)),
    );
}

async function activeQueueRows(stationId: string, db: Executor): Promise<QueueRow[]> {
  const rows = await selectQueueRows(db).where(
    and(eq(queueItems.stationId, stationId), inArray(queueItems.status, ['queued', 'playing'])),
  );
  return rows.map(toQueueRow);
}

/** The first track of whoever is at the front of the rotation. */
async function nextQueuedRow(stationId: string, db: Database): Promise<QueueRow | null> {
  const [row] = await selectQueueRows(db)
    .where(
      and(
        eq(queueItems.stationId, stationId),
        eq(queueItems.status, 'queued'),
        isNotNull(stationSeats.seq),
      ),
    )
    .orderBy(asc(stationSeats.seq), asc(queueItems.position), asc(queueItems.requestedAt))
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

/**
 * The station a user holds a seat in, if any. A seat is held from the first
 * queued track until the last one has played, so this is also the one station
 * they can queue in until then.
 */
async function seatStationOf(userId: string, db: Executor): Promise<string | null> {
  const [seat] = await db
    .select({ stationId: stationSeats.stationId })
    .from(stationSeats)
    .where(eq(stationSeats.userId, userId));
  return seat?.stationId ?? null;
}

/** Joins the back of the rotation, unless already waiting somewhere in it. */
async function joinRotation(userId: string, stationId: string, db: Executor): Promise<void> {
  await db.insert(stationSeats).values({ userId, stationId }).onConflictDoNothing();
}

function leaveRotation(userId: string, db: Executor) {
  return db.delete(stationSeats).where(eq(stationSeats.userId, userId));
}

/**
 * Called once a person's track is done with. They go to the back if they still
 * have something queued, and otherwise leave the rotation until they queue again.
 */
async function cycleRotation(userId: string, db: Executor): Promise<void> {
  if (await hasQueuedTracks(userId, db)) {
    await db
      .update(stationSeats)
      .set({ seq: sql`nextval('dj_rotation_seq')` })
      .where(eq(stationSeats.userId, userId));
  } else {
    await leaveRotation(userId, db);
  }
}

/** Leaves the rotation once nothing is left waiting. */
async function leaveRotationIfEmpty(userId: string, db: Executor): Promise<void> {
  if (!(await hasQueuedTracks(userId, db))) await leaveRotation(userId, db);
}

/** The station a queue item belongs to, or a 404 when there is no such item. */
export async function stationOfQueueItem(
  queueItemId: string,
  db: Database = getDatabase(),
): Promise<string> {
  const [item] = await db
    .select({ stationId: queueItems.stationId })
    .from(queueItems)
    .where(eq(queueItems.id, queueItemId));
  if (!item) throw new StationError('QUEUE_ITEM_NOT_FOUND', 'That queue item does not exist.', 404);
  return item.stationId;
}

async function getSettings(stationId: string, db: Database) {
  await ensureStationExists(stationId, db);
  const [settings] = await db
    .select({
      description: stationSettings.description,
      maxDurationSeconds: stationSettings.maxDurationSeconds,
      repeatCooldownSeconds: stationSettings.repeatCooldownSeconds,
      targetCountry: stationSettings.targetCountry,
      skipMode: stationSettings.skipMode,
      skipDownvotes: stationSettings.skipDownvotes,
      skipRatioPercent: stationSettings.skipRatioPercent,
      revealRequester: stationSettings.revealRequester,
    })
    .from(stationSettings)
    .where(eq(stationSettings.stationId, stationId));
  if (!settings) throw new StationError('STATION_NOT_READY', 'The station has not been initialized.', 500);
  return settings;
}

async function assertRepeatCooldownPassed(
  stationId: string,
  provider: MediaMetadata['provider'],
  providerMediaId: string,
  cooldownSeconds: number,
  db: Database,
  options: { excludeQueueItemId?: string; now?: Date } = {},
): Promise<void> {
  const conditions = [
    eq(queueItems.stationId, stationId),
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
  throw new StationError(
    'TRACK_RECENTLY_PLAYED',
    `That track played ${elapsed}. Try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
  );
}

async function validateForPlayback(
  stationId: string,
  candidate: QueueRow,
  maxDurationSeconds: number,
  repeatCooldownSeconds: number,
  targetCountry: string,
  db: Database,
): Promise<MediaMetadata> {
  const checked = await lookupMediaCached(candidate.media.canonicalUrl, targetCountry, db);
  if (checked.durationSeconds > maxDurationSeconds) {
    throw new StationError(
      'TRACK_TOO_LONG',
      `Tracks must be ${Math.floor(maxDurationSeconds / 60)} minutes or shorter.`,
    );
  }
  const blocking = await findBlockingRules(stationId, checked, db);
  if (blocking.length > 0) {
    throw new StationError('MEDIA_BLOCKED', `This track breaks ${describeBlock(blocking)}.`);
  }
  await assertRepeatCooldownPassed(
    stationId,
    checked.provider,
    checked.providerMediaId,
    repeatCooldownSeconds,
    db,
    { excludeQueueItemId: candidate.id },
  );
  return checked;
}

export async function startNextTrack(
  stationId: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  const settings = await getSettings(stationId, db);

  for (;;) {
    const [state] = await db
      .select({ currentQueueItemId: stationState.currentQueueItemId })
      .from(stationState)
      .where(eq(stationState.stationId, stationId));
    if (state?.currentQueueItemId) return false;

    const candidate = await nextQueuedRow(stationId, db);
    if (!candidate) return false;

    let checked: MediaMetadata;
    try {
      checked = await validateForPlayback(
        stationId,
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
      await leaveRotationIfEmpty(candidate.requestedBy.id, db);
      await bumpRevision(stationId, db);
      continue;
    }

    const started = await db.transaction(async (transaction) => {
      await lockStation(stationId, transaction);
      const [lockedState] = await transaction
        .select({ currentQueueItemId: stationState.currentQueueItemId })
        .from(stationState)
        .where(eq(stationState.stationId, stationId));
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
        .update(stationState)
        .set({
          currentQueueItemId: candidate.id,
          revision: sql`${stationState.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(stationState.stationId, stationId));
      return true;
    });
    return started;
  }
}

export async function advanceCurrentTrack(
  stationId: string,
  status: 'played' | 'skipped',
  reason: string | null,
  expectedQueueItemId?: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  await ensureStationExists(stationId, db);
  const advanced = await db.transaction(async (transaction) => {
    await lockStation(stationId, transaction);
    const [state] = await transaction
      .select({ currentQueueItemId: stationState.currentQueueItemId })
      .from(stationState)
      .where(eq(stationState.stationId, stationId));
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
      .update(stationState)
      .set({
        currentQueueItemId: null,
        revision: sql`${stationState.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(stationState.stationId, stationId));
    return true;
  });

  if (advanced) await startNextTrack(stationId, db);
  return advanced;
}

export async function advanceIfExpired(
  stationId: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  const [current] = await db
    .select({
      id: queueItems.id,
      startedAt: queueItems.startedAt,
      durationSeconds: media.durationSeconds,
    })
    .from(stationState)
    .innerJoin(queueItems, eq(stationState.currentQueueItemId, queueItems.id))
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(eq(stationState.stationId, stationId));

  if (!current?.startedAt) {
    return startNextTrack(stationId, db);
  }
  const endsAt = current.startedAt.getTime() + current.durationSeconds * 1_000;
  return Date.now() >= endsAt
    ? advanceCurrentTrack(stationId, 'played', null, current.id, db)
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
  if (!stored) throw new StationError('QUEUE_FAILED', 'The track could not be saved.', 500);

  // The first time the station sees a track, go and find out what it is. This
  // returns at once and the answer lands whenever the services get round to
  // it; nothing about queueing or playing waits on it.
  enrichTrack(
    metadata.provider,
    metadata.providerMediaId,
    metadata.title,
    metadata.artist,
    db,
  );
  return stored.id;
}

/**
 * Turns a link into a stored `media` row for the personal playlist library.
 *
 * Saving is not admission, so this runs none of the station policy `enqueueMedia`
 * enforces: no duration limit, no blocklist, no repeat cooldown, no active
 * duplicate check. A track the station refuses today can still be kept and queued
 * once the station allows it. The provider lookup is the one step that cannot be
 * skipped, because an unknown link has no title, artist, or duration until a
 * provider answers for it.
 */
export async function resolveMediaForLibrary(
  url: string,
  db: Database = getDatabase(),
): Promise<string> {
  // The library belongs to no station, so it reads the main station's region.
  const settings = await getSettings(MAIN_STATION_ID, db);
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
 * Like `resolveMediaForLibrary` it stores metadata and applies no station policy,
 * so a playlist holding blocked or overlong tracks still saves in full. A track
 * the provider itself refuses comes back with a reason instead of a media ID.
 */
export async function resolvePlaylistForLibrary(
  url: string,
  db: Database = getDatabase(),
): Promise<LibraryTrack[]> {
  const settings = await getSettings(MAIN_STATION_ID, db);
  const env = getEnv();
  const trackUrls = await listPlaylistTrackUrls(
    parsePlaylistUrl(url),
    { youtubeApiKey: env.YOUTUBE_API_KEY },
    MAX_PLAYLIST_TRACKS,
  );
  if (trackUrls.length === 0) {
    throw new StationError('PLAYLIST_EMPTY', 'That playlist has no playable tracks.');
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

/**
 * Whether this station takes a track: its length limit, its rules, a copy of it
 * already waiting or playing here, and the repeat cooldown. Throws the first
 * reason it would not. A request and a queue moving in both ask this.
 */
async function assertAdmissible(
  stationId: string,
  metadata: MediaMetadata,
  settings: Awaited<ReturnType<typeof getSettings>>,
  db: Database,
): Promise<void> {
  if (metadata.durationSeconds > settings.maxDurationSeconds) {
    throw new StationError(
      'TRACK_TOO_LONG',
      `Tracks must be ${Math.floor(settings.maxDurationSeconds / 60)} minutes or shorter.`,
    );
  }

  const blocking = await findBlockingRules(stationId, metadata, db);
  if (blocking.length > 0) {
    const byArtist = blocking.find(({ entryType }) => entryType === 'artist');
    const scope = byArtist ? `${byArtist.label} is blocked` : 'That track is blocked';
    throw new StationError('MEDIA_BLOCKED', `${scope} under ${describeBlock(blocking)}.`);
  }

  const [activeDuplicate] = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(
      and(
        eq(media.provider, metadata.provider),
        eq(media.providerMediaId, metadata.providerMediaId),
        eq(queueItems.stationId, stationId),
        inArray(queueItems.status, ['queued', 'playing']),
      ),
    )
    .limit(1);
  if (activeDuplicate) throw new StationError('ALREADY_QUEUED', 'That track is already in the station queue.');

  await assertRepeatCooldownPassed(
    stationId,
    metadata.provider,
    metadata.providerMediaId,
    settings.repeatCooldownSeconds,
    db,
  );
}

export async function enqueueMedia(
  stationId: string,
  url: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<{ id: string; provider: 'youtube' | 'soundcloud'; durationSeconds: number }> {
  const settings = await getSettings(stationId, db);
  const seatStation = await seatStationOf(user.id, db);
  if (seatStation !== null && seatStation !== stationId) {
    throw new StationError(
      'QUEUED_ELSEWHERE',
      'You already have tracks waiting in another station. A listener queues in one station at a time.',
      409,
    );
  }
  const metadata = await lookupMediaCached(url, settings.targetCountry, db);
  await assertAdmissible(stationId, metadata, settings, db);

  const storedMediaId = await storeMedia(metadata, db);

  const [{ nextPosition }] = await db
    .select({
      nextPosition: sql<number>`coalesce(max(${queueItems.position}), -1) + 1`.mapWith(Number),
    })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')));

  const [item] = await db
    .insert(queueItems)
    .values({ stationId, mediaId: storedMediaId, requestedByUserId: user.id, position: nextPosition })
    .returning({ id: queueItems.id });
  if (!item) throw new StationError('QUEUE_FAILED', 'The request could not be queued.', 500);

  await joinRotation(user.id, stationId, db);
  await bumpRevision(stationId, db);
  await startNextTrack(stationId, db);
  return {
    id: item.id,
    provider: metadata.provider,
    durationSeconds: metadata.durationSeconds,
  };
}

/**
 * What moving someone's waiting tracks into this station would do: the station they
 * are queued in now, and each track with the reason this station would refuse it,
 * or null when it would come along. Nothing changes; this is the question the
 * listener is asked before they confirm.
 */
export async function planQueueMove(
  stationId: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<QueueMovePlan> {
  const seatStation = await seatStationOf(user.id, db);
  if (seatStation === null || seatStation === stationId) return { from: null, tracks: [] };

  const [from] = await db
    .select({ slug: stations.slug, name: stations.name })
    .from(stations)
    .where(eq(stations.id, seatStation));
  const settings = await getSettings(stationId, db);
  const waiting = await db
    .select({
      id: queueItems.id,
      provider: media.provider,
      providerMediaId: media.providerMediaId,
      providerArtistId: media.providerArtistId,
      canonicalUrl: media.canonicalUrl,
      title: media.title,
      artist: media.artist,
      durationSeconds: media.durationSeconds,
      thumbnailUrl: media.thumbnailUrl,
    })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')))
    .orderBy(asc(queueItems.position), asc(queueItems.requestedAt));

  const tracks: QueueMovePlan['tracks'] = [];
  for (const { id, ...metadata } of waiting) {
    let refused: string | null = null;
    try {
      await assertAdmissible(stationId, metadata, settings, db);
    } catch (error) {
      if (!(error instanceof StationError)) throw error;
      refused = error.message;
    }
    tracks.push({ queueItemId: id, title: metadata.title, artist: metadata.artist, refused });
  }
  return { from: from ?? null, tracks };
}

/**
 * Moves someone's waiting tracks into this station, in their order, and puts them
 * at the back of its rotation. A track this station refuses is taken out of their
 * queue with the reason as a notice, because a listener queues in one station and
 * the old one is no longer theirs. A track already playing elsewhere finishes
 * there.
 */
export async function moveQueue(
  stationId: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<QueueMovePlan> {
  const plan = await planQueueMove(stationId, user, db);
  const fromStationId = await seatStationOf(user.id, db);
  if (plan.from === null || fromStationId === null) return plan;

  await db.transaction(async (transaction) => {
    // Always the same order, so two moves in opposite directions cannot each
    // hold the lock the other is waiting for.
    for (const id of [fromStationId, stationId].sort()) await lockStation(id, transaction);
    const now = new Date();
    for (const track of plan.tracks) {
      await transaction
        .update(queueItems)
        .set(
          track.refused === null
            ? { stationId }
            : {
                status: 'removed',
                finishedAt: now,
                moderationReason: `Not taken to another station: ${track.refused}`,
                listenerNotice: `Left behind when your queue moved: ${track.refused}`,
              },
        )
        .where(and(eq(queueItems.id, track.queueItemId), eq(queueItems.status, 'queued')));
    }
    await leaveRotation(user.id, transaction);
    if (plan.tracks.some((track) => track.refused === null)) {
      await joinRotation(user.id, stationId, transaction);
    }
    await bumpRevision(fromStationId, transaction);
    await bumpRevision(stationId, transaction);
  });
  await startNextTrack(stationId, db);
  return plan;
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
  stationId: string,
  url: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<PlaylistImport> {
  const settings = await getSettings(stationId, db);
  const env = getEnv();
  const parsed = parsePlaylistUrl(url);
  const trackUrls = await listPlaylistTrackUrls(
    parsed,
    { youtubeApiKey: env.YOUTUBE_API_KEY },
    MAX_QUEUE_IMPORT_TRACKS,
  );
  if (trackUrls.length === 0) {
    throw new StationError('PLAYLIST_EMPTY', 'That playlist has no playable tracks.');
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
      await enqueueMedia(stationId, trackUrl, user, db);
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
    .select({
      id: queueItems.id,
      stationId: queueItems.stationId,
      requestedByUserId: queueItems.requestedByUserId,
    })
    .from(queueItems)
    .where(and(eq(queueItems.id, queueItemId), eq(queueItems.status, 'playing')))
    .limit(1);
  if (!item) throw new StationError('NOT_PLAYING', 'Voting has closed for that track.');
  if (item.requestedByUserId === user.id) {
    throw new StationError('OWN_TRACK', 'You cannot vote on your own request.');
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
  await bumpRevision(item.stationId, db);

  if (value === -1 && (await downvotesForceSkip(item.stationId, queueItemId, eligibleVoterCount, db))) {
    await advanceCurrentTrack(item.stationId, 'skipped', 'Skipped by station vote.', queueItemId, db);
  }
}

/**
 * Whether the station has voted a track off. In ratio mode the bar moves with the
 * audience, and a station with nobody in it can never reach it.
 */
async function downvotesForceSkip(
  stationId: string,
  queueItemId: string,
  eligibleVoterCount: number,
  db: Database,
): Promise<boolean> {
  const settings = await getSettings(stationId, db);
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
    .select({ id: queueItems.id, stationId: queueItems.stationId })
    .from(queueItems)
    .where(and(eq(queueItems.requestedByUserId, user.id), eq(queueItems.status, 'queued')))
    .orderBy(asc(queueItems.position));

  const owned = new Set(mine.map(({ id }) => id));
  const unknown = orderedIds.find((id) => !owned.has(id));
  if (unknown) throw new StationError('NOT_YOUR_TRACK', 'That track is not in your queue.');

  const ordered = [...orderedIds, ...mine.map(({ id }) => id).filter((id) => !orderedIds.includes(id))];
  await db.transaction(async (transaction) => {
    for (const [position, id] of ordered.entries()) {
      await transaction.update(queueItems).set({ position }).where(eq(queueItems.id, id));
    }
  });
  // One station at a time, so every track of theirs is in the same one.
  if (mine[0]) await bumpRevision(mine[0].stationId, db);
}

function orderedStationQueueRows(activeRows: QueueRow[], currentQueueItemId: string | null): QueueRow[] {
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

/** Reorders the DJ rotation shown in the station queue without changing personal queues. */
export async function reorderStationQueue(
  stationId: string,
  orderedIds: string[],
  moderator: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  await ensureStationExists(stationId, db);
  await db.transaction(async (transaction) => {
    await lockStation(stationId, transaction);
    const [state] = await transaction
      .select({ currentQueueItemId: stationState.currentQueueItemId })
      .from(stationState)
      .where(eq(stationState.stationId, stationId));
    const activeRows = await activeQueueRows(stationId, transaction);
    const stationRows = orderedStationQueueRows(activeRows, state?.currentQueueItemId ?? null);
    const byId = new Map(stationRows.map((row) => [row.id, row]));

    if (orderedIds.length !== stationRows.length || orderedIds.some((id) => !byId.has(id))) {
      throw new StationError('QUEUE_CHANGED', 'The station queue changed. Try the move again.', 409);
    }

    const currentRequesterId = activeRows.find(({ id }) => id === state?.currentQueueItemId)?.requestedBy.id;
    const currentRequesterRow = stationRows.find(({ requestedBy }) => requestedBy.id === currentRequesterId);
    if (currentRequesterRow && orderedIds.at(-1) !== currentRequesterRow.id) {
      throw new StationError(
        'CURRENT_DJ_LOCKED',
        "The current DJ's next turn must stay at the bottom until this track ends.",
      );
    }

    for (const id of orderedIds) {
      const row = byId.get(id)!;
      await transaction
        .update(stationSeats)
        .set({ seq: sql`nextval('dj_rotation_seq')` })
        .where(eq(stationSeats.userId, row.requestedBy.id));
    }
    await transaction.insert(moderationActions).values({
      actorUserId: moderator.id,
      action: 'reorder_station_queue',
      details: { orderedIds },
    });
    await bumpRevision(stationId, transaction);
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
    .returning({ id: queueItems.id, stationId: queueItems.stationId });

  await leaveRotation(userId, db);
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'clear_queue',
    details: { userId, reason, removed: cleared.length },
  });
  for (const stationId of new Set(cleared.map((item) => item.stationId))) await bumpRevision(stationId, db);
  return cleared.length;
}

export async function skipCurrentTrack(
  stationId: string,
  reason: string,
  moderator: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [state] = await db
    .select({ currentQueueItemId: stationState.currentQueueItemId })
    .from(stationState)
    .where(eq(stationState.stationId, stationId));
  if (!state?.currentQueueItemId) throw new StationError('NOTHING_PLAYING', 'There is no track to skip.');

  await db.insert(moderationActions).values({
    actorUserId: moderator.id,
    action: 'skip',
    queueItemId: state.currentQueueItemId,
    details: { reason },
  });
  await advanceCurrentTrack(stationId, 'skipped', reason, state.currentQueueItemId, db);
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
    .returning({
      id: queueItems.id,
      stationId: queueItems.stationId,
      requestedByUserId: queueItems.requestedByUserId,
    });
  if (!removed) throw new StationError('NOT_QUEUED', 'That track is no longer queued.');
  await leaveRotationIfEmpty(removed.requestedByUserId, db);
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'remove',
    queueItemId,
    details: { reason },
  });
  await bumpRevision(removed.stationId, db);
}

/**
 * A listener taking back one of their own tracks before it plays. Unlike a
 * moderator removal this records no moderation action: there is nothing to
 * answer for. The track they are currently playing is not theirs to pull.
 */
/**
 * Clearing the notice is how it is marked read: the station only ever needs to
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
    throw new StationError('NOTICE_NOT_FOUND', 'There is no unread notice of yours with that id.', 404);
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
    .returning({ id: queueItems.id, stationId: queueItems.stationId });
  if (!withdrawn) {
    throw new StationError(
      'NOT_YOUR_QUEUED_TRACK',
      'That track is not one of yours waiting to play.',
      404,
    );
  }
  await leaveRotationIfEmpty(owner.id, db);
  await bumpRevision(withdrawn.stationId, db);
}

/** What is being blocked, however somebody arrived at it. */
interface BlockTarget {
  provider: MediaProvider;
  entryType: 'track' | 'artist';
  /** The id the entry is keyed by: one track, or everything by one artist. */
  providerId: string;
  /** What a reader sees on the list. */
  label: string;
  /** The row this came from, where the station has one. */
  mediaId?: string | null;
  /** The request this came from, where a request is what prompted it. */
  queueItemId?: string | null;
}

/**
 * The part of blocking that is the same whether a moderator blocked the track
 * playing now or an admin pasted a link: write the entry under every rule
 * named, all of them this station's, drop everything already queued here that the
 * entry now covers, and record what was done. The caller bumps the revision.
 */
async function applyBlock(
  stationId: string,
  target: BlockTarget,
  options: { ruleIds: string[]; note?: string | null },
  moderator: AuthenticatedUser,
  db: Database,
): Promise<{ removed: number }> {
  if (options.ruleIds.length === 0) {
    throw new StationError('NO_RULE_GIVEN', 'Choose at least one rule to block this under.');
  }
  await assertRulesInStation(stationId, options.ruleIds, db);

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
    .select({ id: queueItems.id, requestedByUserId: queueItems.requestedByUserId })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .where(and(eq(queueItems.stationId, stationId), eq(queueItems.status, 'queued'), covered));
  if (doomed.length > 0) {
    await db
      .update(queueItems)
      .set({
        status: 'removed',
        finishedAt: new Date(),
        moderationReason: options.note ?? 'Blocked by a station rule.',
      })
      .where(inArray(queueItems.id, doomed.map(({ id }) => id)));
    for (const userId of new Set(doomed.map((item) => item.requestedByUserId))) {
      await leaveRotationIfEmpty(userId, db);
    }
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
      stationId: queueItems.stationId,
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
  if (!item) throw new StationError('QUEUE_ITEM_NOT_FOUND', 'That queue item does not exist.', 404);

  const blockingArtist = options.entryType === 'artist';
  await applyBlock(
    item.stationId,
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
    await advanceCurrentTrack(item.stationId, 'skipped', 'Blocked by a station rule.', queueItemId, db);
  } else {
    await bumpRevision(item.stationId, db);
  }
}

/**
 * Blocking something nobody has requested yet.
 *
 * A link is read the same way a request is, so an admin can block a track, or
 * everything by whoever published it, before it ever reaches the station. Nothing
 * is added to `media` on the way: a track the station has never played does not
 * need a row here just to be refused, and the entry is keyed by the provider's
 * own id either way.
 *
 * On YouTube the artist is the channel; on SoundCloud it is the account that
 * uploaded the track. Both are what that provider hangs a catalogue off.
 */
export async function blockMediaByUrl(
  stationId: string,
  url: string,
  options: { ruleIds: string[]; entryType: 'track' | 'artist'; note?: string | null },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<{ label: string; removed: number }> {
  const settings = await getSettings(stationId, db);
  const { metadata } = await inspectMediaCached(url, settings.targetCountry, db);
  const blockingArtist = options.entryType === 'artist';

  // A row only if the station happens to have one, so the log can point at it.
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
    stationId,
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

  // The rule list is on the player, so the station hears about it even when no
  // queued track was covered.
  await bumpRevision(stationId, db);
  return { label, removed };
}

export type StationSettingsPatch = Partial<{
  description: string;
  maxDurationSeconds: number;
  repeatCooldownSeconds: number;
  targetCountry: string;
  skipMode: 'absolute' | 'ratio';
  skipDownvotes: number;
  skipRatioPercent: number;
  revealRequester: boolean;
}>;

export async function updateStationSettings(
  stationId: string,
  patch: StationSettingsPatch,
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  if (Object.keys(patch).length === 0) {
    throw new StationError('NO_SETTINGS_GIVEN', 'No settings were provided.');
  }
  await db
    .update(stationSettings)
    .set({ ...patch, updatedAt: new Date(), updatedByUserId: admin.id })
    .where(eq(stationSettings.stationId, stationId));
  await db.insert(moderationActions).values({
    actorUserId: admin.id,
    action: 'update_settings',
    details: patch,
  });
  await bumpRevision(stationId, db);
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

export async function getStationSnapshot(
  stationId: string,
  me: AuthenticatedUser | null,
  listenerCount: number,
  db: Database = getDatabase(),
): Promise<StationSnapshot> {
  await ensureStationExists(stationId, db);
  if (me) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, me.id));
  }

  const [station, state, settings, activeRows, stats, rules, myNotices, myStationRole] = await Promise.all([
    db
      .select({ slug: stations.slug, name: stations.name })
      .from(stations)
      .where(eq(stations.id, stationId))
      .then(([row]) => row),
    db
      .select({ revision: stationState.revision, currentQueueItemId: stationState.currentQueueItemId })
      .from(stationState)
      .where(eq(stationState.stationId, stationId))
      .then(([row]) => row),
    getSettings(stationId, db),
    activeQueueRows(stationId, db),
    listJammers(10, undefined, db),
    listActiveRules(stationId, db),
    me ? listMyNotices(me.id, db) : [],
    stationRoleOf(me, stationId, db),
  ]);

  if (!station) throw new StationError('STATION_NOT_FOUND', 'That station does not exist.', 404);
  if (!state) throw new StationError('STATION_NOT_READY', 'The station has not been initialized.', 500);
  const currentRow = activeRows.find(({ id }) => id === state.currentQueueItemId) ?? null;

  // The station queue is one track per person: what each of them plays on their
  // next turn, in the order the station will reach them.
  const stationQueueRows = orderedStationQueueRows(activeRows, state.currentQueueItemId);
  const queuedRows = activeRows
    .filter(({ status }) => status === 'queued')
    .sort(
      (left, right) =>
        left.position - right.position || left.requestedAt.getTime() - right.requestedAt.getTime(),
    );
  const myQueueRows = me ? queuedRows.filter(({ requestedBy }) => requestedBy.id === me.id) : [];

  const hydrated = await queueWithVotes(
    [...(currentRow ? [currentRow] : []), ...stationQueueRows, ...myQueueRows],
    me?.id,
    db,
  );
  const byId = new Map(hydrated.map((item) => [item.id, item]));
  const current = currentRow ? byId.get(currentRow.id) ?? null : null;

  /**
   * With the requester hidden, votes are cast on the track alone. The name
   * comes back as the track runs out, and the station's mods and owners always
   * see it.
   */
  const secondsLeft =
    current?.startedAt && current.media.durationSeconds
      ? (new Date(current.startedAt).getTime() + current.media.durationSeconds * 1_000 - Date.now()) /
        1_000
      : Number.POSITIVE_INFINITY;
  const privileged = myStationRole !== null;
  const censor = !settings.revealRequester && !privileged;
  const hide = <T extends { id: string; requestedBy: StationUser | null }>(item: T, reveal: boolean): T =>
    censor && !reveal && item.requestedBy?.id !== me?.id ? { ...item, requestedBy: null } : item;

  return {
    station,
    serverTime: new Date().toISOString(),
    revision: state.revision,
    listenerCount,
    settings,
    me: toStationUser(me),
    myStationRole,
    current: current ? hide(current, secondsLeft <= REVEAL_REQUESTER_WITHIN_SECONDS) : null,
    currentGenres: current
      ? nowPlayingGenres(
          { provider: current.media.provider, providerMediaId: current.media.providerMediaId },
          current.media.title,
          current.media.artist,
          db,
        )
      : null,
    queue: stationQueueRows.map((row) => hide(byId.get(row.id)!, false)),
    myQueue: myQueueRows.map((row) => byId.get(row.id)!),
    myNotices,
    selectorStats: stats,
    rules,
  };
}

/** The public view of a signed-in listener: no Destiny tokens, roles, or features. */
export function toStationUser(user: AuthenticatedUser | null): StationUser | null {
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

export async function currentRevision(
  stationId: string,
  db: Database = getDatabase(),
): Promise<number> {
  await ensureStationExists(stationId, db);
  const [state] = await db
    .select({ revision: stationState.revision })
    .from(stationState)
    .where(eq(stationState.stationId, stationId));
  return state?.revision ?? 0;
}
