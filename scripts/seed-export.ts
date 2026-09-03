/**
 * Writes what the room ships with, out of the database it was worked out in.
 *
 *   npx tsx scripts/seed-export.ts
 *
 * Two files, both committed, both applied at startup by `src/server/seed.ts`:
 *
 *   data/legacy-plays.json.gz   the QueUp years, about 3 MB
 *   data/genres.json            what every track is, about 5 MB
 *
 * Run this after topping the archive up or after a dump import, then commit
 * what changed. A deployment then carries it without fetching anything.
 *
 * Only DATABASE_URL is needed, from the environment or `.env`.
 */

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';
import { describeDatabase } from '../src/server/genre';

const ARCHIVE_FILE = 'data/legacy-plays.json.gz';
const GENRE_FILE = 'data/genres.json';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }
  console.log(`Database: ${describeDatabase(url)}`);
  const db = drizzle({ connection: url, schema });

  // Ordered so that regenerating an unchanged database produces an unchanged
  // file, and a commit diff is only what actually moved.
  const plays = await db
    .select()
    .from(schema.legacyPlays)
    .orderBy(asc(schema.legacyPlays.sourceId));
  const archive = plays.map((row) => ({
    source_id: row.sourceId,
    played_at: row.playedAt.toISOString(),
    requester_name: row.requesterName,
    provider: row.provider,
    provider_media_id: row.providerMediaId,
    title: row.title,
    duration_seconds: row.durationSeconds,
    thumbnail_url: row.thumbnailUrl,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    skipped: row.skipped,
  }));
  await writeFile(ARCHIVE_FILE, gzipSync(Buffer.from(JSON.stringify(archive), 'utf8')));

  const genres = await db
    .select()
    .from(schema.trackGenres)
    .orderBy(asc(schema.trackGenres.providerMediaId), asc(schema.trackGenres.source));
  const rows = genres.map((row) => ({
    provider: row.provider,
    providerMediaId: row.providerMediaId,
    source: row.source,
    level: row.level,
    genres: row.genres,
    styles: row.styles,
    sourceEntityId: row.sourceEntityId,
    sourceUrl: row.sourceUrl,
    ambiguous: row.ambiguous,
  }));
  await writeFile(GENRE_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), rows }), 'utf8');

  const labelled = rows.filter((row) => row.genres.length > 0).length;
  console.log(
    `${ARCHIVE_FILE}: ${archive.length.toLocaleString()} plays\n` +
      `${GENRE_FILE}: ${rows.length.toLocaleString()} answers, ` +
      `${labelled.toLocaleString()} carrying a genre`,
  );
  process.exit(0);
}

await main();
