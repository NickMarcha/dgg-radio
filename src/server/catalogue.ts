import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ArtistDetail,
  MediaProvider,
  TrackDetail,
  TrackPlay,
  TrackSummary,
} from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { legacyPlays, media, queueItems } from './db/schema';
import { listGenres, trackKey } from './genre';

/**
 * What the room knows about one track, or about whoever published it.
 *
 * Both are keyed by the provider's own id rather than by a `media` row, for the
 * same reason genre is: most of what the room knows about is the QueUp archive,
 * and none of that has a row here. A track nobody has played in this room still
 * has a page, built from what the archive remembers.
 *
 * The two histories stay apart all the way through. QueUp's requesters are
 * names with no account behind them and its votes were cast on another site, so
 * they are shown as a second list rather than folded into the room's own.
 */

export class CatalogueError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 404,
  ) {
    super(message);
    this.name = 'CatalogueError';
  }
}

/** How many plays of one track are worth listing before it is just a wall. */
const PLAYS_SHOWN = 50;
/** How many other tracks to offer at the bottom of a page. */
const RELATED_SHOWN = 12;

interface PlayRow extends Record<string, unknown> {
  requester_id: string | null;
  requester_name: string;
  requester_avatar: string | null;
  requester_role: 'listener' | 'mod' | 'admin' | null;
  requester_team: 'pepe' | 'yee' | null;
  requester_flair: string | null;
  requester_emote: string | null;
  played_at: Date;
  upvotes: number;
  downvotes: number;
  skipped: boolean;
}

function toPlay(row: PlayRow): TrackPlay {
  return {
    // An account only where there is one. The archive has names and no more.
    requester: row.requester_id
      ? {
          id: row.requester_id,
          username: row.requester_name,
          avatarUrl: row.requester_avatar,
          role: row.requester_role ?? 'listener',
          team: row.requester_team,
          flair: row.requester_flair,
          topEmote: row.requester_emote,
        }
      : null,
    requesterName: row.requester_name,
    playedAt: new Date(row.played_at).toISOString(),
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    status: row.skipped ? 'skipped' : 'played',
  };
}

/**
 * Other tracks worth offering, by plays across both histories. Used for both
 * "more from this channel" and "more in this genre", which differ only in what
 * they match on.
 */
function relatedQuery(match: ReturnType<typeof sql>, exclude: string) {
  return sql`
    with candidates as (${match}),
    plays as (
      select media.provider, media.provider_media_id, count(*)::int as plays
      from queue_items
      join media on media.id = queue_items.media_id
      where queue_items.started_at is not null
      group by media.provider, media.provider_media_id
      union all
      select provider, provider_media_id, count(*)::int
      from legacy_plays
      group by provider, provider_media_id
    )
    select
      candidates.provider,
      candidates.provider_media_id,
      candidates.title,
      candidates.thumbnail_url,
      coalesce(sum(plays.plays), 0)::int as plays
    from candidates
    left join plays
      on plays.provider = candidates.provider
     and plays.provider_media_id = candidates.provider_media_id
    where candidates.provider_media_id <> ${exclude}
    group by
      candidates.provider,
      candidates.provider_media_id,
      candidates.title,
      candidates.thumbnail_url
    order by coalesce(sum(plays.plays), 0) desc, candidates.title
    limit ${RELATED_SHOWN}`;
}

interface SummaryRow extends Record<string, unknown> {
  provider: MediaProvider;
  provider_media_id: string;
  title: string;
  thumbnail_url: string | null;
  plays: number;
}

function toSummary(row: SummaryRow): TrackSummary {
  return {
    provider: row.provider,
    providerMediaId: row.provider_media_id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
    plays: row.plays,
  };
}

export async function getTrackDetail(
  provider: MediaProvider,
  providerMediaId: string,
  db: Database = getDatabase(),
): Promise<TrackDetail> {
  const [known] = await db
    .select()
    .from(media)
    .where(and(eq(media.provider, provider), eq(media.providerMediaId, providerMediaId)))
    .limit(1);

  // What the archive remembers, which is all there is for most tracks.
  const [archive] = await db
    .select({
      plays: sql<number>`count(*)::int`.mapWith(Number),
      title: sql<string | null>`min(${legacyPlays.title})`,
      thumbnailUrl: sql<string | null>`min(${legacyPlays.thumbnailUrl})`,
      durationSeconds: sql<number | null>`min(${legacyPlays.durationSeconds})`,
      upvotes: sql<number>`coalesce(sum(${legacyPlays.upvotes}), 0)::int`.mapWith(Number),
      downvotes: sql<number>`coalesce(sum(${legacyPlays.downvotes}), 0)::int`.mapWith(Number),
      first: sql<Date | null>`min(${legacyPlays.playedAt})`,
      last: sql<Date | null>`max(${legacyPlays.playedAt})`,
    })
    .from(legacyPlays)
    .where(
      and(eq(legacyPlays.provider, provider), eq(legacyPlays.providerMediaId, providerMediaId)),
    );

  if (!known && (archive?.plays ?? 0) === 0) {
    throw new CatalogueError('TRACK_NOT_FOUND', 'This room has no record of that track.');
  }

  const [roomPlays, archivePlays, genres, [roomTotals]] = await Promise.all([
    db.execute<PlayRow>(sql`
      select
        users.id as requester_id,
        users.username as requester_name,
        users.avatar_url as requester_avatar,
        users.role as requester_role,
        users.team as requester_team,
        users.flair as requester_flair,
        users.top_emote as requester_emote,
        queue_items.started_at as played_at,
        (select count(*) from votes where votes.queue_item_id = queue_items.id and votes.value = 1)::int as upvotes,
        (select count(*) from votes where votes.queue_item_id = queue_items.id and votes.value = -1)::int as downvotes,
        queue_items.status = 'skipped' as skipped
      from queue_items
      join media on media.id = queue_items.media_id
      join users on users.id = queue_items.requested_by_user_id
      where media.provider = ${provider}
        and media.provider_media_id = ${providerMediaId}
        and queue_items.status in ('played', 'skipped')
      order by queue_items.started_at desc
      limit ${PLAYS_SHOWN}
    `),
    db.execute<PlayRow>(sql`
      select
        null::uuid as requester_id,
        requester_name,
        null::text as requester_avatar,
        null::user_role as requester_role,
        null::user_team as requester_team,
        null::text as requester_flair,
        null::text as requester_emote,
        played_at,
        upvotes,
        downvotes,
        skipped
      from legacy_plays
      where provider = ${provider} and provider_media_id = ${providerMediaId}
      order by played_at desc
      limit ${PLAYS_SHOWN}
    `),
    listGenres([{ provider, providerMediaId }], db),
    db
      .select({
        // Distinct, because the vote join multiplies a play by its votes.
        plays: sql<number>`count(distinct ${queueItems.id})::int`.mapWith(Number),
        upvotes: sql<number>`count(*) filter (where votes.value = 1)::int`.mapWith(Number),
        downvotes: sql<number>`count(*) filter (where votes.value = -1)::int`.mapWith(Number),
        first: sql<Date | null>`min(${queueItems.startedAt})`,
        last: sql<Date | null>`max(${queueItems.startedAt})`,
      })
      .from(queueItems)
      .innerJoin(media, eq(queueItems.mediaId, media.id))
      .leftJoin(sql`votes`, sql`votes.queue_item_id = ${queueItems.id}`)
      .where(
        and(
          eq(media.provider, provider),
          eq(media.providerMediaId, providerMediaId),
          sql`${queueItems.startedAt} is not null`,
        ),
      ),
  ]);

  const summary = genres.get(trackKey(provider, providerMediaId)) ?? null;

  // Two ways to find something else worth playing: the same channel, and the
  // same genre. The first needs an artist id, which only a `media` row has.
  const byArtist = known
    ? await db.execute<SummaryRow>(
        relatedQuery(
          sql`select provider, provider_media_id, title, thumbnail_url from media
              where provider = ${provider} and provider_artist_id = ${known.providerArtistId}`,
          providerMediaId,
        ),
      )
    : { rows: [] as SummaryRow[] };

  const names = summary?.entries.flatMap((entry) => [...entry.genres, ...entry.styles]) ?? [];
  // Listed one parameter at a time: an array bound as a single value would be
  // compared against as a scalar and Postgres refuses it.
  const lowered = sql.join(
    names.map((name) => sql`${name.toLowerCase()}`),
    sql`, `,
  );
  const byGenre = names.length
    ? await db.execute<SummaryRow>(
        relatedQuery(
          sql`select distinct on (shared.provider, shared.provider_media_id)
                shared.provider, shared.provider_media_id, shared.title, shared.thumbnail_url
              from (
                select provider, provider_media_id, title, thumbnail_url from media
                union all
                select provider, provider_media_id, min(title), min(thumbnail_url)
                from legacy_plays group by provider, provider_media_id
              ) as shared
              where exists (
                select 1 from track_genres
                cross join lateral unnest(track_genres.genres || track_genres.styles) as label(name)
                where track_genres.provider = shared.provider
                  and track_genres.provider_media_id = shared.provider_media_id
                  and lower(label.name) in (${lowered})
              )
              order by shared.provider, shared.provider_media_id`,
          providerMediaId,
        ),
      )
    : { rows: [] as SummaryRow[] };

  const archivePlayCount = archive?.plays ?? 0;
  const roomPlayCount = roomTotals?.plays ?? 0;

  return {
    provider,
    providerMediaId,
    title: known?.title ?? archive?.title ?? providerMediaId,
    artist: known?.artist ?? null,
    providerArtistId: known?.providerArtistId ?? null,
    canonicalUrl:
      known?.canonicalUrl ??
      (provider === 'youtube' ? `https://www.youtube.com/watch?v=${providerMediaId}` : null),
    thumbnailUrl: known?.thumbnailUrl ?? archive?.thumbnailUrl ?? null,
    durationSeconds: known?.durationSeconds ?? archive?.durationSeconds ?? null,
    mediaId: known?.id ?? null,
    genres: summary,
    totals: {
      roomPlays: roomPlayCount,
      archivePlays: archivePlayCount,
      upvotes: (roomTotals?.upvotes ?? 0) + (archive?.upvotes ?? 0),
      downvotes: (roomTotals?.downvotes ?? 0) + (archive?.downvotes ?? 0),
      firstPlayed: earliest(roomTotals?.first ?? null, archive?.first ?? null),
      lastPlayed: latest(roomTotals?.last ?? null, archive?.last ?? null),
    },
    roomPlays: roomPlays.rows.map(toPlay),
    archivePlays: archivePlays.rows.map(toPlay),
    related: {
      byArtist: byArtist.rows.map(toSummary),
      byGenre: byGenre.rows.map(toSummary),
    },
  };
}

function earliest(left: Date | null, right: Date | null): string | null {
  const times = [left, right].filter((value): value is Date => value !== null).map((value) => new Date(value));
  if (times.length === 0) return null;
  return new Date(Math.min(...times.map((time) => time.getTime()))).toISOString();
}

function latest(left: Date | null, right: Date | null): string | null {
  const times = [left, right].filter((value): value is Date => value !== null).map((value) => new Date(value));
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((time) => time.getTime()))).toISOString();
}

/**
 * Everything the room has by one channel or account.
 *
 * Only tracks with a `media` row can be attributed: the archive stores who
 * requested a play and never who made the track, so a track that only ever
 * played on QueUp belongs to nobody here. Its archive plays still count, once
 * the room has a row saying whose it is.
 */
export async function getArtistDetail(
  provider: MediaProvider,
  providerArtistId: string,
  db: Database = getDatabase(),
): Promise<ArtistDetail> {
  const [known] = await db
    .select({ artist: media.artist })
    .from(media)
    .where(and(eq(media.provider, provider), eq(media.providerArtistId, providerArtistId)))
    .orderBy(desc(media.createdAt))
    .limit(1);
  if (!known) {
    throw new CatalogueError('ARTIST_NOT_FOUND', 'This room has no tracks by that artist.');
  }

  // The counts are wrapped rather than ordered by directly: Postgres allows a
  // bare output alias in `order by` but not an expression over two of them.
  const tracks = await db.execute<SummaryRow & { room_plays: number; archive_plays: number }>(sql`
    select * from (
      select
        media.provider,
        media.provider_media_id,
        media.title,
        media.thumbnail_url,
        (
          select count(*) from queue_items
          where queue_items.media_id = media.id and queue_items.started_at is not null
        )::int as room_plays,
        (
          select count(*) from legacy_plays
          where legacy_plays.provider = media.provider
            and legacy_plays.provider_media_id = media.provider_media_id
        )::int as archive_plays
      from media
      where media.provider = ${provider} and media.provider_artist_id = ${providerArtistId}
    ) as tracks
    order by tracks.room_plays + tracks.archive_plays desc, tracks.title
  `);

  const genres = await listGenres(
    tracks.rows.map((row) => ({ provider: row.provider, providerMediaId: row.provider_media_id })),
    db,
  );
  const counted = new Map<string, { name: string; tracks: number }>();
  for (const row of tracks.rows) {
    const summary = genres.get(trackKey(row.provider, row.provider_media_id));
    for (const entry of summary?.entries ?? []) {
      // The artist's own genres would say the same thing for every track.
      if (entry.level === 'artist') continue;
      for (const name of [...entry.genres, ...entry.styles]) {
        const key = name.toLowerCase();
        const seen = counted.get(key);
        counted.set(key, { name: seen?.name ?? name, tracks: (seen?.tracks ?? 0) + 1 });
      }
    }
  }

  return {
    provider,
    providerArtistId,
    name: known.artist,
    totals: {
      tracks: tracks.rows.length,
      roomPlays: tracks.rows.reduce((total, row) => total + row.room_plays, 0),
      archivePlays: tracks.rows.reduce((total, row) => total + row.archive_plays, 0),
    },
    genres: [...counted.values()]
      .sort((left, right) => right.tracks - left.tracks || left.name.localeCompare(right.name))
      .slice(0, 8),
    tracks: tracks.rows.map((row) => ({
      ...toSummary({ ...row, plays: row.room_plays + row.archive_plays }),
      roomPlays: row.room_plays,
      archivePlays: row.archive_plays,
    })),
  };
}
