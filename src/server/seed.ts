import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import { legacyPlays, seedState } from './db/schema';
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
 * Each file is applied once. Its digest is recorded in `seed_state`, and an
 * unchanged file is skipped on every later start rather than offering 68,000
 * rows to be told each one is already there. Regenerating a file changes its
 * digest, so it applies again without anyone remembering to say so.
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

/**
 * The file, and a digest of exactly the bytes on disk. Hashing the file rather
 * than what it parses to means a regenerated file always re-applies, even if
 * the change is one row's spelling.
 *
 * Gzipped because it is 16 MB of JSON and 3 MB is a kinder thing to commit.
 */
async function readJson<T>(path: string): Promise<{ data: T; digest: string } | null> {
  try {
    const raw = await readFile(path);
    const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return { data: JSON.parse(text) as T, digest: createHash('sha256').update(raw).digest('hex') };
  } catch {
    return null;
  }
}

/** Whether this exact file has been applied before. */
async function alreadyApplied(name: string, digest: string, db: Database): Promise<boolean> {
  const [seen] = await db
    .select({ digest: seedState.digest })
    .from(seedState)
    .where(eq(seedState.name, name));
  return seen?.digest === digest;
}

/**
 * Recorded only after the rows are in. A crash midway leaves no note, so the
 * next start reads the file again and fills whatever did not land.
 */
async function markApplied(name: string, digest: string, db: Database): Promise<void> {
  await db
    .insert(seedState)
    .values({ name, digest })
    .onConflictDoUpdate({ target: seedState.name, set: { digest, appliedAt: new Date() } });
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
  const file = await readJson<ArchiveRow[]>(path);
  if (!file?.data.length) return null;
  const rows = file.data;
  if (await alreadyApplied('archive', file.digest, db)) return { added: 0, kept: rows.length };

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
  await markApplied('archive', file.digest, db);
  return { added, kept: rows.length - added };
}

export async function applyGenreSeed(
  path = 'data/genres.json',
  db: Database = getDatabase(),
): Promise<{ added: number; kept: number } | null> {
  const file = await readJson<{ rows?: StoredGenre[] }>(path);
  const rows = file?.data.rows;
  if (!file || !rows?.length) return null;
  if (await alreadyApplied('genres', file.digest, db)) return { added: 0, kept: rows.length };

  let added = 0;
  for (let start = 0; start < rows.length; start += BATCH) {
    added += await seedGenres(rows.slice(start, start + BATCH), db);
  }
  await markApplied('genres', file.digest, db);
  return { added, kept: rows.length - added };
}

/** Both of them, in the order that makes the second one worth having. */
export async function applySeeds(db: Database = getDatabase()): Promise<SeedReport> {
  return {
    archive: await applyArchiveSeed(undefined, db),
    genres: await applyGenreSeed(undefined, db),
  };
}
