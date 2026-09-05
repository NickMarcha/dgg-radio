import { sql, type SQL } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import { genreStatsQuery } from './genre';

/**
 * Taking the room's data out of it, as CSV.
 *
 * This exists because everything the room knows is either in a database nobody
 * can reach without a shell on the deployment host, or in a temporary file that
 * Windows will delete. An admin should be able to keep a copy of the archive,
 * of what has played, and of what the providers said, without either.
 *
 * CSV rather than JSON because these are read as much as they are kept: every
 * one of them opens in a spreadsheet. The one thing that does not fit the shape
 * is the provider cache's stored answers, which stay as JSON inside their cell.
 *
 * Each export is one query and one response. The largest of them is the QueUp
 * archive at 48,000 rows and about 15 MB in the database, which is a few
 * seconds and a few tens of megabytes of memory once — acceptable for something
 * an admin asks for by hand, and the reason there is no export of the vote or
 * moderation tables, which are joined into the rows that need them instead.
 */

export type ExportId =
  | 'history'
  | 'archive'
  | 'tracks'
  | 'lookups'
  | 'stats-tracks'
  | 'stats-jammers'
  | 'stats-genres';

export interface ExportDefinition {
  id: ExportId;
  /** What the button says. */
  label: string;
  /** What is in it, for somebody deciding whether they want it. */
  description: string;
}

export const EXPORTS: ExportDefinition[] = [
  {
    id: 'history',
    label: 'Room history',
    description: 'Every track this room has played or skipped, with who requested it and its votes.',
  },
  {
    id: 'archive',
    label: 'QueUp archive',
    description: 'The plays imported from QueUp, as they were imported.',
  },
  {
    id: 'tracks',
    label: 'Track catalogue',
    description: 'Every track the room has a row for, with what each source says it is.',
  },
  {
    id: 'lookups',
    label: 'Provider cache',
    description: 'What YouTube and SoundCloud last said about each track, including refusals.',
  },
  {
    id: 'stats-tracks',
    label: 'Stats: tracks',
    description: 'Every track by plays and votes, not only the hundred the stats page shows.',
  },
  {
    id: 'stats-jammers',
    label: 'Stats: jammers',
    description: 'Every listener by plays and the votes their requests drew.',
  },
  {
    id: 'stats-genres',
    label: 'Stats: genres',
    description: 'Every genre by plays, this room and the QueUp archive counted apart.',
  },
];

/**
 * What a source says a track is, as one column per source. A track can carry a
 * row from each, so this cannot be a join without turning one track into two.
 */
function genreColumn(source: 'discogs' | 'musicbrainz', provider: SQL, providerMediaId: SQL): SQL {
  return sql`coalesce((
    select string_agg(distinct label.name, ', ')
    from track_genres
    cross join lateral unnest(track_genres.genres || track_genres.styles) as label(name)
    where track_genres.provider = ${provider}
      and track_genres.provider_media_id = ${providerMediaId}
      and track_genres.source = ${source}
  ), '')`;
}

function genreColumns(provider: SQL, providerMediaId: SQL): SQL {
  return sql`
    ${genreColumn('discogs', provider, providerMediaId)} as discogs_genres,
    ${genreColumn('musicbrainz', provider, providerMediaId)} as musicbrainz_genres`;
}

function query(id: ExportId): SQL {
  if (id === 'history') {
    return sql`
      select
        queue_items.id as play_id,
        queue_items.started_at,
        queue_items.finished_at,
        queue_items.status,
        users.username as requested_by,
        media.provider,
        media.provider_media_id,
        media.canonical_url,
        media.title,
        media.artist,
        media.duration_seconds,
        (select count(*) from votes where votes.queue_item_id = queue_items.id and votes.value = 1) as upvotes,
        (select count(*) from votes where votes.queue_item_id = queue_items.id and votes.value = -1) as downvotes,
        ${genreColumns(sql`media.provider`, sql`media.provider_media_id`)}
      from queue_items
      join media on media.id = queue_items.media_id
      join users on users.id = queue_items.requested_by_user_id
      where queue_items.status in ('played', 'skipped')
      order by queue_items.started_at desc`;
  }

  if (id === 'archive') {
    return sql`
      select
        source_id,
        played_at,
        requester_name,
        provider,
        provider_media_id,
        title,
        duration_seconds,
        thumbnail_url,
        upvotes,
        downvotes,
        skipped,
        ${genreColumns(sql`legacy_plays.provider`, sql`legacy_plays.provider_media_id`)}
      from legacy_plays
      order by played_at desc`;
  }

  if (id === 'tracks') {
    return sql`
      select
        media.provider,
        media.provider_media_id,
        media.provider_artist_id,
        media.canonical_url,
        media.title,
        media.artist,
        media.duration_seconds,
        media.created_at,
        ${genreColumns(sql`media.provider`, sql`media.provider_media_id`)}
      from media
      order by media.created_at desc`;
  }

  if (id === 'lookups') {
    return sql`
      select
        key,
        provider,
        checked_at,
        playback_issue_code,
        playback_issue_message,
        metadata::text as metadata,
        region_restriction::text as region_restriction
      from media_lookups
      order by checked_at desc`;
  }

  // The stats page shows the head of each of these. The export is all of it,
  // which is most of the reason to want the file.
  if (id === 'stats-tracks') {
    return sql`
      select
        media.provider,
        media.provider_media_id,
        media.title,
        media.artist,
        media.canonical_url,
        count(*)::int as plays,
        count(*) filter (where votes.value = 1)::int as upvotes,
        count(*) filter (where votes.value = -1)::int as downvotes,
        coalesce(sum(votes.value), 0)::int as score,
        ${genreColumns(sql`media.provider`, sql`media.provider_media_id`)}
      from queue_items
      join media on media.id = queue_items.media_id
      left join votes on votes.queue_item_id = queue_items.id
      where queue_items.started_at is not null
      group by media.id
      order by count(*) desc, coalesce(sum(votes.value), 0) desc`;
  }

  if (id === 'stats-jammers') {
    return sql`
      select
        users.username,
        users.role,
        users.team,
        users.flair,
        count(distinct queue_items.id)::int as plays,
        count(*) filter (where votes.value = 1)::int as upvotes,
        count(*) filter (where votes.value = -1)::int as downvotes,
        coalesce(sum(votes.value), 0)::int as score,
        users.created_at as joined_at,
        users.last_seen_at
      from users
      left join queue_items
        on queue_items.requested_by_user_id = users.id
       and queue_items.started_at is not null
      left join votes on votes.queue_item_id = queue_items.id
      group by users.id
      order by coalesce(sum(votes.value), 0) desc, count(distinct queue_items.id) desc`;
  }

  return sql`
    select genre, room_plays, archive_plays, array_to_string(sources, ', ') as sources
    from (${genreStatsQuery(null)}) as counted`;
}

/**
 * One CSV cell. Everything is quoted rather than only what has to be: a title
 * with a comma, a quote and a newline in it is ordinary here, and deciding per
 * value is more ways to be wrong than it is worth.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The whole export, header included. Column names come from what the query
 * actually returned rather than from a list kept beside it, so the two cannot
 * drift apart and an empty table still exports its header.
 */
export async function exportCsv(id: ExportId, db: Database = getDatabase()): Promise<string> {
  const result = await db.execute(query(id));
  const columns = result.fields.map((field) => field.name);
  const lines = [columns.map(cell).join(',')];
  for (const row of result.rows) {
    lines.push(columns.map((column) => cell((row as Record<string, unknown>)[column])).join(','));
  }
  // A trailing newline, so the last row is a line like every other one.
  return `${lines.join('\r\n')}\r\n`;
}

/** What the browser saves it as. Dated, because these are kept as copies. */
export function exportFilename(id: ExportId): string {
  const today = new Date().toISOString().slice(0, 10);
  return `dgg-radio-${id}-${today}.csv`;
}
