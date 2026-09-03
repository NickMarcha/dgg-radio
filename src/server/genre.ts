import { readFile } from 'node:fs/promises';
import { sql, type Column, type SQL } from 'drizzle-orm';
import type {
  GenreLevel,
  GenreSource,
  GenreStats,
  MediaProvider,
  StatsPeriod,
  TrackGenre,
  TrackGenres,
} from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { trackGenres } from './db/schema';
import { searchGenre } from './discogs';
import { songTitle } from './musicbrainz';
import { ALL_TIME, periodRange } from './period';

/**
 * Reading and writing what a track is.
 *
 * Genre is a property of the recording rather than of this room's copy of one,
 * so everything here is keyed by the provider's own id. That is what lets the
 * QueUp archive be labelled: those 34,114 tracks have no `media` row, and the
 * point of the import was not to make one for each.
 *
 * Two sources are kept side by side and never merged. Discogs has about fifteen
 * broad genres plus a sharper `styles` list; MusicBrainz has a folksonomy of
 * hundreds. On the sample where both had a track-level genre only 10 of 16
 * shared a normalised token, and several of the six misses were taxonomy
 * artefacts rather than disagreements -- `afrobeat, funk, jazz` against
 * `Funk / Soul` is the same claim in two vocabularies. Normalising them
 * together would manufacture both false agreement and false conflict, so each
 * source keeps its own row, its own words and its own link.
 *
 * See `docs/research/discogs-dump-genre-coverage.md` for what each source
 * covers and how that was measured.
 */

/**
 * The genre the room ships with.
 *
 * Working out what a track is takes 8 GB of downloads and half an hour of
 * scanning, and it produces a few thousand short answers. Those answers are
 * committed to the repository, and applying them is what this does — so a
 * deployment gets everything the archive has been labelled with by deploying,
 * without fetching a byte of anyone's data dump.
 *
 * The file is the source of truth. It is re-applied on every start because
 * doing so is idempotent and takes a couple of seconds, which is a smaller
 * thing to reason about than remembering whether it has been applied yet. That
 * does mean a genre worked out directly against a deployed database is
 * overwritten on the next deploy: regenerate the file instead, with
 * `scripts/genre-transfer.ts export`.
 *
 * Missing or unreadable is not an error. Genre is decoration on top of a room
 * that works without it, so a bad seed file must never be what stops the API
 * from serving.
 */
export async function applyGenreSeed(
  path = 'data/genres.json',
  db: Database = getDatabase(),
): Promise<{ applied: number } | null> {
  let rows: StoredGenre[];
  try {
    const file = JSON.parse(await readFile(path, 'utf8')) as { rows?: StoredGenre[] };
    if (!Array.isArray(file.rows) || file.rows.length === 0) return null;
    rows = file.rows;
  } catch {
    return null;
  }

  for (let start = 0; start < rows.length; start += 1_000) {
    await storeGenres(rows.slice(start, start + 1_000), db);
  }
  return { applied: rows.length };
}

/**
 * Which database a script is about to write to, without its password.
 *
 * These imports are run by hand, often with DATABASE_URL overridden to point
 * somewhere other than the `.env` default, and writing the archive or a genre
 * backfill into the wrong one is silent. Saying which one out loud turns that
 * into something a person notices before it happens.
 */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.username}@${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'an unreadable DATABASE_URL';
  }
}

export interface TrackKey {
  provider: MediaProvider;
  providerMediaId: string;
}

/** One string per track, so a page of rows can be looked up by it. */
export function trackKey(provider: MediaProvider, providerMediaId: string): string {
  return `${provider}:${providerMediaId}`;
}

export interface StoredGenre extends TrackKey {
  source: GenreSource;
  /** Null records that the source was asked and knew nothing. */
  level: GenreLevel | null;
  genres: string[];
  styles: string[];
  sourceEntityId: string | null;
  sourceUrl: string | null;
  ambiguous: boolean;
}

function toTrackGenre(row: {
  source: GenreSource;
  level: GenreLevel | null;
  genres: string[];
  styles: string[];
  sourceUrl: string | null;
  ambiguous: boolean;
}): TrackGenre | null {
  // A row with no genres is a recorded absence, which is worth storing so the
  // source is not asked twice, and worth nothing to a reader.
  if (!row.level || row.genres.length === 0) return null;
  return {
    source: row.source,
    level: row.level,
    genres: row.genres,
    styles: row.styles,
    url: row.sourceUrl,
    ambiguous: row.ambiguous,
  };
}

/**
 * Collects what is known about one track into the shape a page shows: the
 * sources in their own words, whether a second one backed the first, and
 * whether all anyone knows is who made it.
 */
export function summariseGenres(rows: TrackGenre[]): TrackGenres | null {
  if (rows.length === 0) return null;
  // Discogs first: its genres are coarse, which makes them the ones to read
  // first, and its styles carry the detail underneath.
  const entries = [...rows].sort((left, right) => left.source.localeCompare(right.source));
  const aboutTheTrack = entries.filter((entry) => entry.level !== 'artist');
  return {
    entries,
    corroborated: new Set(aboutTheTrack.map((entry) => entry.source)).size > 1,
    artistLevelOnly: aboutTheTrack.length === 0,
  };
}

/**
 * What every source says about a page of tracks, in one query. The row-value
 * `in` matches the primary key's leading columns, so this is an index scan
 * however many tracks are on the page.
 */
export async function listGenres(
  keys: TrackKey[],
  db: Database = getDatabase(),
): Promise<Map<string, TrackGenres>> {
  const wanted = new Map(keys.map((key) => [trackKey(key.provider, key.providerMediaId), key]));
  if (wanted.size === 0) return new Map();

  const tuples = sql.join(
    [...wanted.values()].map(
      (key) => sql`(${key.provider}::media_provider, ${key.providerMediaId})`,
    ),
    sql`, `,
  );
  const rows = await db
    .select()
    .from(trackGenres)
    .where(sql`(${trackGenres.provider}, ${trackGenres.providerMediaId}) in (${tuples})`);

  const collected = new Map<string, TrackGenre[]>();
  for (const row of rows) {
    const entry = toTrackGenre(row);
    if (!entry) continue;
    const key = trackKey(row.provider, row.providerMediaId);
    collected.set(key, [...(collected.get(key) ?? []), entry]);
  }

  const summarised = new Map<string, TrackGenres>();
  for (const [key, entries] of collected) {
    const summary = summariseGenres(entries);
    if (summary) summarised.set(key, summary);
  }
  return summarised;
}

/**
 * Writes one source's answer over whatever it said last. Enrichment reruns are
 * how a track gets a better answer than the one it has, so the newest answer
 * wins rather than being skipped as a duplicate.
 */
export async function storeGenre(
  row: StoredGenre,
  db: Database = getDatabase(),
): Promise<void> {
  const values = {
    provider: row.provider,
    providerMediaId: row.providerMediaId,
    source: row.source,
    level: row.level,
    genres: row.genres,
    styles: row.styles,
    sourceEntityId: row.sourceEntityId,
    sourceUrl: row.sourceUrl,
    ambiguous: row.ambiguous,
    checkedAt: new Date(),
  };
  await db
    .insert(trackGenres)
    .values(values)
    .onConflictDoUpdate({
      target: [trackGenres.provider, trackGenres.providerMediaId, trackGenres.source],
      set: values,
    });
}

/** The same, in one statement, for a run that has thousands of answers to write. */
export async function storeGenres(
  rows: StoredGenre[],
  db: Database = getDatabase(),
): Promise<void> {
  if (rows.length === 0) return;
  const checkedAt = new Date();
  await db
    .insert(trackGenres)
    .values(rows.map((row) => ({ ...row, checkedAt })))
    .onConflictDoUpdate({
      target: [trackGenres.provider, trackGenres.providerMediaId, trackGenres.source],
      set: {
        level: sql`excluded.level`,
        genres: sql`excluded.genres`,
        styles: sql`excluded.styles`,
        sourceEntityId: sql`excluded.source_entity_id`,
        sourceUrl: sql`excluded.source_url`,
        ambiguous: sql`excluded.ambiguous`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}

/**
 * Narrows a history to one genre. Styles count as well as genres, because the
 * tags a reader clicks show both and `Indie Rock` is a style: the distinction
 * is Discogs' and not something anyone should have to know to use this.
 *
 * Artist-level rows are included here, unlike in the stats, because a reader
 * who clicks an artist genre is asking for exactly what the tag they clicked
 * said — the tag itself is labelled as being about the artist.
 */
export function matchesGenre(provider: Column, providerMediaId: Column, genre: string) {
  return sql`exists (
    select 1 from ${trackGenres}
    where ${trackGenres.provider} = ${provider}
      and ${trackGenres.providerMediaId} = ${providerMediaId}
      and exists (
        select 1 from unnest(${trackGenres.genres} || ${trackGenres.styles}) as label(name)
        where lower(label.name) = lower(${genre})
      )
  )`;
}

/** How many genres the stats page shows before the tail stops being readable. */
export const TOP_GENRES = 20;

/**
 * What the community plays, by genre, counted separately for this room and for
 * the QueUp years it inherited.
 *
 * Both histories are counted because the archive is most of what there is: this
 * room has a few hundred plays against the archive's tens of thousands, and a
 * genre chart drawn from the room alone would be about the last few weeks.
 * Keeping them apart is what stops that from being hidden.
 *
 * Artist-level genre is left out. It describes a catalogue rather than a track,
 * so counting it would say the room plays a lot of whatever its most prolific
 * artists are tagged with, which is a different claim from the one being made.
 *
 * The two sources keep their own vocabularies, so this list mixes Discogs'
 * fifteen broad genres with MusicBrainz's much finer ones on purpose. What it
 * does not do is count one track twice for `Rock` and `rock`: names that differ
 * only in case are one name for counting, and the spelling shown is whichever
 * is most common.
 */
export async function getGenreStats(
  db: Database = getDatabase(),
  limit: number | null = TOP_GENRES,
  period: StatsPeriod = ALL_TIME,
): Promise<GenreStats> {
  const [counted, [coverage]] = await Promise.all([
    db.execute<{
      genre: string;
      room_plays: number;
      archive_plays: number;
      sources: GenreSource[];
    }>(genreStatsQuery(limit, period)),
    // Coverage is about the catalogue rather than about a month: how much of
    // what the room knows carries a genre at all. Narrowing it by period would
    // answer a different and much less useful question.
    db.execute<{ labelled_tracks: number; tracks: number }>(sql`
      with known as (
        select distinct provider, provider_media_id from media
        union
        select distinct provider, provider_media_id from legacy_plays
      )
      select
        count(*) filter (where exists (
          select 1 from track_genres
          where track_genres.provider = known.provider
            and track_genres.provider_media_id = known.provider_media_id
            and cardinality(track_genres.genres) > 0
        ))::int as labelled_tracks,
        count(*)::int as tracks
      from known
    `).then((result) => result.rows),
  ]);

  return {
    genres: counted.rows.map((row) => ({
      genre: row.genre,
      roomPlays: row.room_plays,
      archivePlays: row.archive_plays,
      sources: row.sources,
    })),
    coverage: {
      labelledTracks: coverage?.labelled_tracks ?? 0,
      tracks: coverage?.tracks ?? 0,
    },
  };
}

/**
 * The genre counts, as SQL, so the stats page and the export of the same table
 * cannot drift apart. `null` means every genre rather than the handful a page
 * can show.
 */
export function genreStatsQuery(limit: number | null, period: StatsPeriod = ALL_TIME): SQL {
  const range = periodRange(period);
  // Both histories are narrowed by the same window, on whichever column dates
  // a play in each of them.
  const room = range
    ? sql`and queue_items.started_at >= ${range.from} and queue_items.started_at < ${range.to}`
    : sql``;
  const archive = range
    ? sql`where played_at >= ${range.from} and played_at < ${range.to}`
    : sql``;

  return sql`
      with plays as (
        -- Each play carries its own id, or two plays of one track would look
        -- like one and be counted once.
        select
          queue_items.id::text as play_id,
          media.provider,
          media.provider_media_id,
          1 as room,
          0 as archive
        from queue_items
        join media on media.id = queue_items.media_id
        where queue_items.status in ('played', 'skipped') ${room}
        union all
        select source_id, provider, provider_media_id, 0, 1 from legacy_plays ${archive}
      ),
      labelled as (
        select
          plays.play_id,
          plays.room,
          plays.archive,
          track_genres.source,
          lower(label.name) as key,
          label.name
        from plays
        join track_genres
          on track_genres.provider = plays.provider
         and track_genres.provider_media_id = plays.provider_media_id
         and track_genres.level is distinct from 'artist'
        cross join lateral unnest(track_genres.genres || track_genres.styles) as label(name)
      ),
      -- One row per play per genre, so a track both sources agree on is still
      -- one play of that genre.
      per_play as (
        select distinct on (play_id, key) play_id, room, archive, key
        from labelled
        order by play_id, key
      ),
      counted as (
        select key, sum(room)::int as room_plays, sum(archive)::int as archive_plays, count(*) as plays
        from per_play
        group by key
      ),
      -- Which spelling to show: the most used, then a capitalised one over a
      -- lowercase one, so the answer is the same every time it is asked.
      naming as (
        select
          key,
          name,
          row_number() over (
            partition by key
            order by count(*) desc, (left(name, 1) = upper(left(name, 1))) desc, name
          ) as rank
        from labelled
        group by key, name
      ),
      -- Whose word this is. Nearly always one of them, and worth saying so:
      -- a chart that mixes a broad Discogs genre with a narrow MusicBrainz one
      -- is unreadable if it does not admit which is which.
      -- As text, because a Postgres enum array has no client-side parser and
      -- would arrive as an unparsed array literal. Ordering by the text also
      -- sorts alphabetically rather than by how the enum happens to be declared.
      sources as (
        select key, array_agg(distinct source::text order by source::text) as sources
        from labelled
        group by key
      )
      select naming.name as genre, counted.room_plays, counted.archive_plays, sources.sources
      from counted
      join naming on naming.key = counted.key and naming.rank = 1
      join sources on sources.key = counted.key
      order by counted.plays desc, naming.name
      ${limit === null ? sql`limit all` : sql`limit ${limit}`}`;
}

/**
 * How long a live Discogs answer is shown before it is asked for again. The
 * Discogs API terms forbid displaying their content more than six hours staler
 * than their own site and forbid keeping it longer than serving it needs, so
 * this is deliberately short and deliberately in memory.
 */
const DISPLAY_MAX_AGE_MS = 60 * 60 * 1_000;
/** Enough for a long session's worth of tracks, and bounded so it cannot grow. */
const DISPLAY_LIMIT = 500;

const displayed = new Map<string, { genres: TrackGenres | null; storedAt: number }>();
const asking = new Set<string>();

/**
 * Splits an upload title into the artist and track a catalogue would recognise.
 *
 * `Fatboy Slim - Right Here, Right Now [Official 4K Video]` is not a title any
 * catalogue holds and the channel is not who the track is credited to, so
 * neither field can be used as it stands. Most music uploads are named
 * `Artist - Title`, and where they are not, the channel is the better guess
 * once YouTube's own `- Topic` suffix is off it.
 *
 * This is a guess, and a worse one than the video's Music card that the offline
 * enrichment uses. It is safe here because the search it feeds fails closed:
 * a wrong artist returns nothing rather than somebody else's genre.
 */
export function guessTrackIdentity(
  uploadTitle: string,
  channel: string,
): { artist: string; title: string } {
  const split = uploadTitle.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,})$/);
  if (split) return { artist: split[1]!.trim(), title: songTitle(split[2]!) };
  return { artist: channel.replace(/\s*-\s*topic$/i, '').trim(), title: songTitle(uploadTitle) };
}

async function askAboutNowPlaying(
  key: string,
  track: TrackKey,
  uploadTitle: string,
  channel: string,
  db: Database,
): Promise<void> {
  try {
    const stored = await listGenres([track], db);
    const known = stored.get(key);
    if (known) {
      remember(key, known);
      return;
    }
    const identity = guessTrackIdentity(uploadTitle, channel);
    const found = await searchGenre(identity.artist, identity.title);
    remember(key, found ? summariseGenres([found]) : null);
  } catch {
    // A source being unreachable is not worth a room error. Remembering the
    // silence stops every listener's poll from asking again for an hour.
    remember(key, null);
  } finally {
    asking.delete(key);
  }
}

function remember(key: string, genres: TrackGenres | null): void {
  if (displayed.size >= DISPLAY_LIMIT) {
    const oldest = displayed.keys().next().value;
    if (oldest) displayed.delete(oldest);
  }
  displayed.set(key, { genres, storedAt: Date.now() });
}

/**
 * What the track playing now is, without ever making the room wait for it.
 *
 * Every open room asks for the snapshot every fifteen seconds, so this answers
 * from memory or answers null and goes looking in the background. The next poll
 * has whatever it found. That also means one lookup per track rather than one
 * per listener per poll.
 */
export function nowPlayingGenres(
  track: TrackKey,
  uploadTitle: string,
  channel: string,
  db: Database = getDatabase(),
): TrackGenres | null {
  const key = trackKey(track.provider, track.providerMediaId);
  const remembered = displayed.get(key);
  if (remembered && Date.now() - remembered.storedAt < DISPLAY_MAX_AGE_MS) {
    return remembered.genres;
  }
  if (!asking.has(key)) {
    asking.add(key);
    void askAboutNowPlaying(key, track, uploadTitle, channel, db);
  }
  return remembered?.genres ?? null;
}

/**
 * YouTube tracks this source has not answered for, most played first.
 *
 * Most played first is the whole point. Labelling 34,114 tracks against a
 * one-request-a-second API is days of work, and the room repeats far fewer
 * tracks than it has: coverage by play count runs ahead of coverage by track
 * count, so a run that is stopped after an hour has still labelled the music
 * people actually hear.
 *
 * YouTube only, because both sources are reached through the video id: Discogs
 * embeds those in its masters, and identity comes from the video's own Music
 * card. A SoundCloud permalink is neither.
 *
 * `recheckBefore` also returns tracks a source was asked about and had nothing
 * for, when that answer is older than the given time. Without it a negative is
 * permanent, which is wrong for catalogues that keep growing; with it, a
 * monthly pass re-asks about the ones that missed.
 */
export async function listUnlabelledTracks(
  source: GenreSource,
  limit: number,
  recheckBefore: Date | null = null,
  db: Database = getDatabase(),
): Promise<TrackKey[]> {
  const rows = await db.execute<{ provider: MediaProvider; provider_media_id: string }>(sql`
    select known.provider, known.provider_media_id
    from (
      select provider, provider_media_id from media
      union all
      select media.provider, media.provider_media_id
      from queue_items join media on media.id = queue_items.media_id
      union all
      select provider, provider_media_id from legacy_plays
    ) as known
    where known.provider = 'youtube'
      and not exists (
        select 1 from track_genres
        where track_genres.provider = known.provider
          and track_genres.provider_media_id = known.provider_media_id
          and track_genres.source = ${source}
          and (
            cardinality(track_genres.genres) > 0
            or ${recheckBefore === null} or track_genres.checked_at >= ${recheckBefore}
          )
      )
    group by known.provider, known.provider_media_id
    order by count(*) desc, known.provider_media_id
    limit ${limit}
  `);
  return rows.rows.map((row) => ({
    provider: row.provider,
    providerMediaId: row.provider_media_id,
  }));
}
