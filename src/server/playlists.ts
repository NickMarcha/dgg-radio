import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  isPlaylistUrl,
  type PlaylistDetail,
  type PlaylistLibrary,
  type PlaylistQueueResult,
  type PlaylistSaveResult,
  type PlaylistSummary,
  type PlaylistTrack,
} from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { media, playlistItems, playlists } from './db/schema';
import { MediaLookupError } from './media';
import {
  enqueueMedia,
  resolveMediaForLibrary,
  resolvePlaylistForLibrary,
  RoomError,
} from './room';

const MAX_PLAYLIST_TRACKS = 50;

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

  for (const track of playlist.tracks) {
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
