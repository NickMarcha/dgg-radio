import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { getDatabase, type Database } from './db/client';
import { legacyPlays } from './db/schema';
import { seedGenres } from './genre';
import type { StoredGenre } from './genre';

/**
 * What the room ships with.
 *
 * Two things take far longer to work out than they take to carry: the QueUp
 * years, which are two days of somebody else's API at twenty plays a page, and
 * what every one of those tracks is, which is 8 GB of data dumps and half an
 * hour of scanning. Both are committed to the repository, so a deployment gets
 * them by deploying and never fetches either.
 *
 * Everything here only fills gaps. A row the database already has is left
 * exactly as it is, so anything the room has learned since — a play imported
 * last week, a genre worked out against the running database — survives every
 * later deploy. These files are a floor, not an authority.
 *
 * None of it may stop the API serving. A room with no archive and no genre is
 * a working room with less in it, so a missing or unreadable file is a log line
 * rather than a failure.
 */

/** Rows per statement, well inside PostgreSQL's parameter limit. */
const BATCH = 1_000;

export interface SeedReport {
  archive: { added: number; kept: number } | null;
  genres: { added: number; kept: number } | null;
}

type ArchiveRow = {
  source_id: string;
  played_at: string;
  requester_name: string;
  provider: 'youtube' | 'soundcloud';
  provider_media_id: string;
  title: string;
  duration_seconds: number;
  thumbnail_url: string | null;
  upvotes: number;
  downvotes: number;
  skipped: boolean;
};

/** Gzipped because it is 16 MB of JSON and 3 MB is a kinder thing to commit. */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path);
    const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * The QueUp years. Keyed by QueUp's own id for the play, so this can be run
 * against a database that already holds some of them — which is exactly what
 * happens on every restart after the first.
 */
export async function applyArchiveSeed(
  path = 'data/legacy-plays.json.gz',
  db: Database = getDatabase(),
): Promise<{ added: number; kept: number } | null> {
  const rows = await readJson<ArchiveRow[]>(path);
  if (!rows?.length) return null;

  let added = 0;
  for (let start = 0; start < rows.length; start += BATCH) {
    const written = await db
      .insert(legacyPlays)
      .values(
        rows.slice(start, start + BATCH).map((row) => ({
          sourceId: row.source_id,
          playedAt: new Date(row.played_at),
          requesterName: row.requester_name,
          provider: row.provider,
          providerMediaId: row.provider_media_id,
          title: row.title,
          durationSeconds: row.duration_seconds,
          thumbnailUrl: row.thumbnail_url,
          upvotes: row.upvotes,
          downvotes: row.downvotes,
          skipped: row.skipped,
        })),
      )
      .onConflictDoNothing()
      .returning({ sourceId: legacyPlays.sourceId });
    added += written.length;
  }
  return { added, kept: rows.length - added };
}

export async function applyGenreSeed(
  path = 'data/genres.json',
  db: Database = getDatabase(),
): Promise<{ added: number; kept: number } | null> {
  const file = await readJson<{ rows?: StoredGenre[] }>(path);
  if (!file?.rows?.length) return null;

  let added = 0;
  for (let start = 0; start < file.rows.length; start += BATCH) {
    added += await seedGenres(file.rows.slice(start, start + BATCH), db);
  }
  return { added, kept: file.rows.length - added };
}

/** Both of them, in the order that makes the second one worth having. */
export async function applySeeds(db: Database = getDatabase()): Promise<SeedReport> {
  return {
    archive: await applyArchiveSeed(undefined, db),
    genres: await applyGenreSeed(undefined, db),
  };
}
