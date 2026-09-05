import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  isPlaylistUrl,
  MAX_IMPORT_TRACKS,
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_IMPORT_TRACKS,
  queupImportSchema,
  type LegacySaveResult,
  type QueupImportResult,
  type PlaylistDetail,
  type PlaylistLibrary,
  type PlaylistQueueResult,
  type PlaylistSaveResult,
  type PlaylistSummary,
  type PlaylistTrack,
} from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { legacyPlays, media, playlistItems, playlists } from './db/schema';
import { queupTrackUrl } from './legacy';
import { MediaLookupError } from './media';
import { warmYouTubeLookups } from './media-cache';
import {
  enqueueMedia,
  resolveMediaForLibrary,
  resolvePlaylistForLibrary,
  RoomError,
} from './room';

function hasDatabaseCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === code) return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export class PlaylistError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'PlaylistError';
  }
}

function summaryRow() {
  return {
    id: playlists.id,
    name: playlists.name,
    trackCount: sql<number>`count(${playlistItems.mediaId})::int`.mapWith(Number),
    updatedAt: playlists.updatedAt,
  };
}

function toSummary(row: {
  id: string;
  name: string;
  trackCount: number;
  updatedAt: Date;
}): PlaylistSummary {
  return {
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedPlaylist(playlistId: string, ownerId: string, db: Database) {
  const [playlist] = await db
    .select({ id: playlists.id, name: playlists.name, updatedAt: playlists.updatedAt })
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
    .limit(1);
  if (!playlist) {
    throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
  }
  return playlist;
}

export async function listPlaylists(
  ownerId: string,
  membershipMediaIds: string[] = [],
  db: Database = getDatabase(),
): Promise<PlaylistLibrary> {
  const rows = await db
    .select(summaryRow())
    .from(playlists)
    .leftJoin(playlistItems, eq(playlists.id, playlistItems.playlistId))
    .where(eq(playlists.ownerUserId, ownerId))
    .groupBy(playlists.id)
    .orderBy(desc(playlists.updatedAt), asc(playlists.name));

  const memberships: Record<string, string[]> = {};
  if (membershipMediaIds.length > 0) {
    const membershipRows = await db
      .select({ mediaId: playlistItems.mediaId, playlistId: playlists.id })
      .from(playlistItems)
      .innerJoin(playlists, eq(playlistItems.playlistId, playlists.id))
      .where(
        and(
          eq(playlists.ownerUserId, ownerId),
          inArray(playlistItems.mediaId, membershipMediaIds),
        ),
      );
    for (const row of membershipRows) {
      (memberships[row.mediaId] ??= []).push(row.playlistId);
    }
  }

  return { playlists: rows.map(toSummary), memberships };
}

export async function getPlaylist(
  playlistId: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<PlaylistDetail> {
  const playlist = await ownedPlaylist(playlistId, ownerId, db);
  const rows = await db
    .select({
      position: playlistItems.position,
      addedAt: playlistItems.addedAt,
      id: media.id,
      provider: media.provider,
      providerMediaId: media.providerMediaId,
      providerArtistId: media.providerArtistId,
      canonicalUrl: media.canonicalUrl,
      title: media.title,
      artist: media.artist,
      durationSeconds: media.durationSeconds,
      thumbnailUrl: media.thumbnailUrl,
    })
    .from(playlistItems)
    .innerJoin(media, eq(playlistItems.mediaId, media.id))
    .where(eq(playlistItems.playlistId, playlistId))
    .orderBy(asc(playlistItems.position), asc(playlistItems.addedAt));

  const tracks: PlaylistTrack[] = rows.map((row) => ({
    position: row.position,
    addedAt: row.addedAt.toISOString(),
    media: {
      id: row.id,
      provider: row.provider,
      providerMediaId: row.providerMediaId,
      providerArtistId: row.providerArtistId,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      artist: row.artist,
      durationSeconds: row.durationSeconds,
      thumbnailUrl: row.thumbnailUrl,
    },
  }));
  return {
    id: playlist.id,
    name: playlist.name,
    trackCount: tracks.length,
    updatedAt: playlist.updatedAt.toISOString(),
    tracks,
  };
}

export async function createPlaylist(
  name: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<string> {
  try {
    const [created] = await db
      .insert(playlists)
      .values({ name: name.trim(), ownerUserId: ownerId })
      .returning({ id: playlists.id });
    if (!created) {
      throw new PlaylistError('PLAYLIST_CREATE_FAILED', 'The playlist could not be created.', 500);
    }
    return created.id;
  } catch (error) {
    if (hasDatabaseCode(error, '23505')) {
      throw new PlaylistError('PLAYLIST_NAME_TAKEN', 'You already have a playlist with that name.', 409);
    }
    throw error;
  }
}

export async function renamePlaylist(
  playlistId: string,
  name: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<void> {
  try {
    const [renamed] = await db
      .update(playlists)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
      .returning({ id: playlists.id });
    if (!renamed) {
      throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
    }
  } catch (error) {
    if (hasDatabaseCode(error, '23505')) {
      throw new PlaylistError('PLAYLIST_NAME_TAKEN', 'You already have a playlist with that name.', 409);
    }
    throw error;
  }
}

export async function deletePlaylist(
  playlistId: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<void> {
  const [deleted] = await db
    .delete(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
    .returning({ id: playlists.id });
  if (!deleted) {
    throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
  }
}

/** Whether the track went in, or was already there and nothing changed. */
export type PlaylistTrackSave = 'saved' | 'already-saved';

export async function addPlaylistTrack(
  playlistId: string,
  mediaId: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<PlaylistTrackSave> {
  return db.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
      .for('update');
    if (!owned) {
      throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
    }

    const [existing] = await transaction
      .select({ mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, mediaId)));
    if (existing) return 'already-saved';

    const [storedMedia] = await transaction
      .select({ id: media.id })
      .from(media)
      .where(eq(media.id, mediaId));
    if (!storedMedia) {
      throw new PlaylistError('MEDIA_NOT_FOUND', 'That track is no longer available.', 404);
    }

    const [{ count, nextPosition }] = await transaction
      .select({
        count: sql<number>`count(*)::int`.mapWith(Number),
        nextPosition: sql<number>`coalesce(max(${playlistItems.position}), -1) + 1`.mapWith(Number),
      })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId));
    if (count >= MAX_PLAYLIST_TRACKS) {
      throw new PlaylistError(
        'PLAYLIST_FULL',
        `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.`,
      );
    }

    await transaction.insert(playlistItems).values({ playlistId, mediaId, position: nextPosition });
    await transaction
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));
    return 'saved';
  });
}

export async function reorderPlaylist(
  playlistId: string,
  orderedMediaIds: string[],
  ownerId: string,
  db: Database = getDatabase(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
      .for('update');
    if (!owned) {
      throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
    }

    const current = await transaction
      .select({ mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position));
    const currentIds = new Set(current.map(({ mediaId }) => mediaId));
    if (
      current.length !== orderedMediaIds.length ||
      orderedMediaIds.some((mediaId) => !currentIds.has(mediaId))
    ) {
      throw new PlaylistError(
        'PLAYLIST_CHANGED',
        'The playlist changed. Reload it and try the move again.',
        409,
      );
    }

    for (const [position, mediaId] of orderedMediaIds.entries()) {
      await transaction
        .update(playlistItems)
        .set({ position })
        .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, mediaId)));
    }
    await transaction
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));
  });
}

export async function removePlaylistTrack(
  playlistId: string,
  mediaId: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [owned] = await transaction
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.ownerUserId, ownerId)))
      .for('update');
    if (!owned) {
      throw new PlaylistError('PLAYLIST_NOT_FOUND', 'That playlist does not exist.', 404);
    }

    const [removed] = await transaction
      .delete(playlistItems)
      .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, mediaId)))
      .returning({ mediaId: playlistItems.mediaId });
    if (!removed) return;

    const remaining = await transaction
      .select({ mediaId: playlistItems.mediaId })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position), asc(playlistItems.addedAt));
    for (const [position, item] of remaining.entries()) {
      await transaction
        .update(playlistItems)
        .set({ position })
        .where(
          and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.mediaId, item.mediaId)),
        );
    }
    await transaction
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));
  });
}

/**
 * Saves a pasted link or a search result the room has never played. A link
 * naming a whole provider playlist saves every track it holds and reports the
 * ones it could not. Ownership is checked before the provider is asked
 * anything, so a guess at someone else's playlist ID cannot spend a lookup.
 */
export async function addPlaylistTrackByUrl(
  playlistId: string,
  url: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<PlaylistSaveResult> {
  await ownedPlaylist(playlistId, ownerId, db);

  if (!isPlaylistUrl(url)) {
    const mediaId = await resolveMediaForLibrary(url, db);
    const outcome = await addPlaylistTrack(playlistId, mediaId, ownerId, db);
    return {
      attempted: 1,
      saved: outcome === 'saved' ? 1 : 0,
      duplicates: outcome === 'saved' ? 0 : 1,
      skipped: [],
    };
  }

  const tracks = await resolvePlaylistForLibrary(url, db);
  const result: PlaylistSaveResult = {
    attempted: tracks.length,
    saved: 0,
    duplicates: 0,
    skipped: [],
  };
  // Once the playlist is full the rest cannot fit either, so stop trying to
  // store them rather than reporting the same failure one row at a time.
  let full = false;

  for (const track of tracks) {
    if (!track.mediaId) {
      result.skipped.push({ title: track.title, reason: track.reason ?? 'Could not be read.' });
      continue;
    }
    if (full) {
      result.skipped.push({
        title: track.title,
        reason: `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.`,
      });
      continue;
    }
    try {
      if (await addPlaylistTrack(playlistId, track.mediaId, ownerId, db) === 'saved') {
        result.saved += 1;
      } else {
        result.duplicates += 1;
      }
    } catch (error) {
      if (error instanceof PlaylistError) {
        if (error.code === 'PLAYLIST_FULL') full = true;
        result.skipped.push({ title: track.title, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return result;
}

/**
 * Saves one play out of the QueUp archive.
 *
 * The archive deliberately holds no media rows: importing 34,114 of them would
 * have meant a provider lookup each, and almost none of them would ever be
 * wanted. So a row is resolved the first time somebody actually reaches for the
 * track, and from then on it is an ordinary saved track like any other, which
 * is why the answer carries the media id back.
 *
 * Ownership is settled before the provider is asked anything, so a guess at
 * someone else's playlist cannot spend a lookup.
 */
export async function addLegacyPlayToPlaylist(
  playlistId: string,
  sourceId: string,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<LegacySaveResult> {
  await ownedPlaylist(playlistId, ownerId, db);

  const [play] = await db
    .select({
      provider: legacyPlays.provider,
      providerMediaId: legacyPlays.providerMediaId,
    })
    .from(legacyPlays)
    .where(eq(legacyPlays.sourceId, sourceId))
    .limit(1);
  if (!play) {
    throw new PlaylistError('LEGACY_PLAY_NOT_FOUND', 'That archived track is not there.', 404);
  }

  const mediaId = await resolveMediaForLibrary(
    await queupTrackUrl(play.provider, play.providerMediaId),
    db,
  );
  const outcome = await addPlaylistTrack(playlistId, mediaId, ownerId, db);
  return { mediaId, saved: outcome === 'saved' };
}

export async function queuePlaylistTrack(
  playlistId: string,
  mediaId: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): ReturnType<typeof enqueueMedia> {
  await ownedPlaylist(playlistId, user.id, db);
  const [saved] = await db
    .select({ canonicalUrl: media.canonicalUrl })
    .from(playlistItems)
    .innerJoin(media, eq(playlistItems.mediaId, media.id))
    .where(
      and(
        eq(playlistItems.playlistId, playlistId),
        eq(playlistItems.mediaId, mediaId),
      ),
    )
    .limit(1);
  if (!saved) {
    throw new PlaylistError('PLAYLIST_TRACK_NOT_FOUND', 'That track is not in this playlist.', 404);
  }
  return enqueueMedia(saved.canonicalUrl, user, db);
}

/**
 * Queues a saved playlist. A playlist can hold more tracks than one request may
 * queue, so anything past that limit is reported rather than attempted: the
 * caller sees exactly what is still waiting and can ask again.
 */
export async function queuePlaylist(
  playlistId: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<PlaylistQueueResult> {
  const playlist = await getPlaylist(playlistId, user.id, db);
  const result: PlaylistQueueResult = {
    attempted: playlist.tracks.length,
    added: 0,
    skipped: [],
  };

  for (const track of playlist.tracks.slice(MAX_QUEUE_IMPORT_TRACKS)) {
    result.skipped.push({
      mediaId: track.media.id,
      title: track.media.title,
      code: 'QUEUE_IMPORT_LIMIT',
      reason: `Only ${MAX_QUEUE_IMPORT_TRACKS} tracks go in at a time. Add the playlist again for the rest.`,
    });
  }

  for (const track of playlist.tracks.slice(0, MAX_QUEUE_IMPORT_TRACKS)) {
    try {
      await enqueueMedia(track.media.canonicalUrl, user, db);
      result.added += 1;
    } catch (error) {
      if (error instanceof RoomError || error instanceof MediaLookupError) {
        result.skipped.push({
          mediaId: track.media.id,
          title: track.media.title,
          code: error.code,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  return result;
}


export type QueupExport = z.infer<typeof queupImportSchema>;

/** Resolving each distinct track once, whichever playlists it appears in. */
type TrackKey = string;

/** What one track resolved to: a row in `media`, or why it could not be read. */
type ResolvedTrack = { mediaId: string } | { reason: string };

function trackKey(provider: string, providerMediaId: string): TrackKey {
  return `${provider}:${providerMediaId}`;
}

/** Resolves in small parallel groups, the same way a provider playlist import does. */
async function resolveTracks(
  tracks: QueupExport['playlists'][number]['tracks'],
  db: Database,
): Promise<Map<TrackKey, ResolvedTrack>> {
  const resolved = new Map<TrackKey, ResolvedTrack>();
  const concurrency = 5;

  for (let start = 0; start < tracks.length; start += concurrency) {
    await Promise.all(
      tracks.slice(start, start + concurrency).map(async (track) => {
        const key = trackKey(track.provider, track.providerMediaId);
        try {
          const url = await queupTrackUrl(track.provider, track.providerMediaId);
          resolved.set(key, { mediaId: await resolveMediaForLibrary(url, db) });
        } catch (error) {
          resolved.set(key, {
            reason:
              error instanceof MediaLookupError || error instanceof RoomError
                ? error.message
                : 'Could not be read.',
          });
        }
      }),
    );
  }
  return resolved;
}

/**
 * Imports playlists exported from QueUp into someone's own library.
 *
 * A playlist whose name they already have is added to rather than duplicated,
 * so re-importing after adding tracks on QueUp brings across what is new and
 * leaves the rest alone. Tracks are resolved once each across the whole file,
 * and the YouTube half is asked about fifty at a time, so importing a library
 * costs a handful of provider calls rather than one per track.
 */
export async function importQueupPlaylists(
  file: QueupExport,
  ownerId: string,
  db: Database = getDatabase(),
): Promise<QueupImportResult> {
  // One list of every distinct track in the file, trimmed to what a single
  // request can honestly resolve. Everything past that is reported below.
  const wanted: QueupExport['playlists'][number]['tracks'] = [];
  const seen = new Set<TrackKey>();
  for (const playlist of file.playlists) {
    for (const track of playlist.tracks.slice(0, MAX_PLAYLIST_TRACKS)) {
      const key = trackKey(track.provider, track.providerMediaId);
      if (seen.has(key) || wanted.length >= MAX_IMPORT_TRACKS) continue;
      seen.add(key);
      wanted.push(track);
    }
  }

  await warmYouTubeLookups(
    wanted
      .filter((track) => track.provider === 'youtube')
      .map((track) => `https://www.youtube.com/watch?v=${track.providerMediaId}`),
    db,
  );
  const resolved = await resolveTracks(wanted, db);

  const existing = await db
    .select({ id: playlists.id, name: playlists.name })
    .from(playlists)
    .where(eq(playlists.ownerUserId, ownerId));
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row.id]));

  const result: QueupImportResult = { playlists: [] };
  for (const playlist of file.playlists) {
    const name = playlist.name.slice(0, 80).trim();
    const known = byName.get(name.toLowerCase());
    const playlistId = known ?? (await createPlaylist(name, ownerId, db));
    if (!known) byName.set(name.toLowerCase(), playlistId);

    const outcome = {
      name,
      created: !known,
      attempted: playlist.tracks.length,
      saved: 0,
      duplicates: 0,
      skipped: [] as { title: string; reason: string }[],
    };
    let full = false;

    for (const track of playlist.tracks) {
      const answer = resolved.get(trackKey(track.provider, track.providerMediaId));
      const title = track.title || track.providerMediaId;
      if (!answer) {
        outcome.skipped.push({
          title,
          reason: `Only ${MAX_IMPORT_TRACKS} tracks are imported at a time. Import the file again for the rest.`,
        });
        continue;
      }
      if ('reason' in answer) {
        outcome.skipped.push({ title, reason: answer.reason });
        continue;
      }
      if (full) {
        outcome.skipped.push({ title, reason: `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.` });
        continue;
      }
      try {
        if ((await addPlaylistTrack(playlistId, answer.mediaId, ownerId, db)) === 'saved') outcome.saved += 1;
        else outcome.duplicates += 1;
      } catch (error) {
        if (!(error instanceof PlaylistError)) throw error;
        if (error.code === 'PLAYLIST_FULL') full = true;
        outcome.skipped.push({ title, reason: error.message });
      }
    }

    result.playlists.push(outcome);
  }

  return result;
}
