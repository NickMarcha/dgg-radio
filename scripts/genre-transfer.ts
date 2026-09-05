/**
 * Moving genre between a machine that can afford the dumps and one that cannot.
 *
 *   npx tsx scripts/genre-transfer.ts tracks --out tracks.json
 *   npx tsx scripts/genre-transfer.ts export --out genres.json
 *   npx tsx scripts/genre-transfer.ts apply  --in  genres.json
 *
 * The MusicBrainz backfill needs 7.6 GB of dumps and about 17 GB of extracted
 * tables. None of that belongs anywhere near the deployment host, and none of
 * it needs to be: the whole exchange is two small files.
 *
 *   1. `tracks` writes the room's YouTube tracks — a provider id and the upload
 *      title, which is all the matching has to work with. About 3 MB.
 *   2. `musicbrainz-dump-import.ts --tracks tracks.json --out genres.json` runs
 *      wherever the dumps are, and touches no database at all.
 *   3. `apply` writes the answers into `track_genres`. About 4 MB.
 *
 * The Discogs import is the same shape and can be pointed at the same files.
 *
 * `export` is the shortcut past all of it: a machine that has already done the
 * work hands over what it found, and the other end applies it. Nothing has to
 * be recomputed to move genre from a workstation to the room.
 *
 * Only DATABASE_URL is needed, from the environment or `.env`, and only for the
 * two ends.
 */

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';
import { describeDatabase, storeGenres, type StoredGenre } from '../src/server/genre';

/** Rows per insert, well inside PostgreSQL's parameter limit. */
const BATCH = 1_000;

export interface TrackList {
  generatedAt: string;
  tracks: { provider: 'youtube' | 'soundcloud'; providerMediaId: string; title: string }[];
}

export interface GenreFile {
  generatedAt: string;
  rows: StoredGenre[];
}

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }
  console.log(`Database: ${describeDatabase(url)}`);
  return drizzle({ connection: url, schema });
}

/**
 * Every YouTube track either history knows about, with one title each. The
 * archive can hold several spellings of the same upload across two years, and
 * the earliest is as good a guess as any.
 */
async function writeTracks(out: string): Promise<void> {
  const db = database();
  const rows = await db.execute<{ provider_media_id: string; title: string }>(sql`
    select provider_media_id, min(title) as title
    from (
      select provider, provider_media_id, title from media
      union all
      select provider, provider_media_id, title from legacy_plays
    ) as played
    where provider = 'youtube'
    group by provider_media_id
  `);

  const file: TrackList = {
    generatedAt: new Date().toISOString(),
    tracks: rows.rows.map((row) => ({
      provider: 'youtube',
      providerMediaId: row.provider_media_id,
      title: row.title,
    })),
  };
  await writeFile(out, JSON.stringify(file), 'utf8');
  console.log(`Wrote ${file.tracks.length.toLocaleString()} tracks to ${out}`);
}

/** Everything already worked out here, ready to be applied somewhere else. */
async function exportGenres(out: string): Promise<void> {
  const db = database();
  const rows = await db.select().from(schema.trackGenres);

  const file: GenreFile = {
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      provider: row.provider,
      providerMediaId: row.providerMediaId,
      source: row.source,
      level: row.level,
      genres: row.genres,
      styles: row.styles,
      sourceEntityId: row.sourceEntityId,
      sourceUrl: row.sourceUrl,
      ambiguous: row.ambiguous,
    })),
  };
  await writeFile(out, JSON.stringify(file), 'utf8');

  const labelled = file.rows.filter((row) => row.genres.length > 0).length;
  console.log(
    `Wrote ${file.rows.length.toLocaleString()} answers to ${out}, ` +
      `${labelled.toLocaleString()} of them carrying a genre.`,
  );
}

/** Writes answers back, overwriting whatever that source said before. */
async function applyGenres(input: string): Promise<void> {
  const file = JSON.parse(await readFile(input, 'utf8')) as GenreFile;
  if (!Array.isArray(file.rows)) {
    console.error(`${input} is not a genre file.`);
    process.exit(1);
  }

  const db = database();
  for (let start = 0; start < file.rows.length; start += BATCH) {
    await storeGenres(file.rows.slice(start, start + BATCH), db);
    process.stdout.write(
      `\r  stored ${Math.min(start + BATCH, file.rows.length)} / ${file.rows.length}   `,
    );
  }
  process.stdout.write('\n');

  const labelled = file.rows.filter((row) => row.genres.length > 0).length;
  console.log(
    `Applied ${file.rows.length.toLocaleString()} answers from ${file.generatedAt}, ` +
      `${labelled.toLocaleString()} of them carrying a genre.`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'tracks') {
    const out = flag('out');
    if (!out) {
      console.error('Usage: npx tsx scripts/genre-transfer.ts tracks --out tracks.json');
      process.exit(1);
    }
    await writeTracks(out);
  } else if (command === 'export') {
    const out = flag('out');
    if (!out) {
      console.error('Usage: npx tsx scripts/genre-transfer.ts export --out genres.json');
      process.exit(1);
    }
    await exportGenres(out);
  } else if (command === 'apply') {
    const input = flag('in');
    if (!input) {
      console.error('Usage: npx tsx scripts/genre-transfer.ts apply --in genres.json');
      process.exit(1);
    }
    await applyGenres(input);
  } else {
    console.error(
      'Usage:\n' +
        '  npx tsx scripts/genre-transfer.ts tracks --out tracks.json\n' +
        '  npx tsx scripts/genre-transfer.ts export --out genres.json\n' +
        '  npx tsx scripts/genre-transfer.ts apply  --in  genres.json',
    );
    process.exit(1);
  }
  process.exit(0);
}

await main();
