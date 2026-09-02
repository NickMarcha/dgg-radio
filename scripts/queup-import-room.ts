/**
 * Loads a QueUp room export into `legacy_plays`, the archive of what the
 * community played before this room existed.
 *
 *   npx tsx scripts/queup-export-room.ts dgg-radio          # writes the export
 *   npx tsx scripts/queup-import-room.ts queup-dgg-radio.json
 *
 * It writes one table and touches nothing else. No accounts are created, no
 * `media` rows are added, and no provider is asked anything: the archive keeps
 * what QueUp knew, which is enough to list it. Rows are keyed by QueUp's own id
 * for the play, so running this twice adds whatever is new and rewrites nothing
 * — which is how a room that is still running on QueUp gets topped up later.
 *
 * Only DATABASE_URL is needed, from the environment or `.env`. Against the
 * deployed database that means running it where that database is reachable.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { legacyPlays } from '../src/server/db/schema';
import type { RoomExport } from './queup-export-room';

/** Rows per insert. Eleven columns each, well inside PostgreSQL's parameter limit. */
const BATCH = 1_000;

type LegacyRow = typeof legacyPlays.$inferInsert;

/**
 * QueUp carried providers this room has no player for, and tracks it had
 * already lost. Anything that is not a playable YouTube or SoundCloud record
 * is counted and dropped rather than stored as an archive row nobody can act
 * on.
 */
function toRow(play: RoomExport['plays'][number]): LegacyRow | null {
  if (play.provider !== 'youtube' && play.provider !== 'soundcloud') return null;
  if (!play.playedAt || !play.providerMediaId || play.durationSeconds <= 0) return null;
  return {
    sourceId: play.id,
    playedAt: new Date(play.playedAt),
    requesterName: play.requester?.username ?? 'unknown',
    provider: play.provider,
    providerMediaId: play.providerMediaId,
    title: play.title,
    durationSeconds: play.durationSeconds,
    thumbnailUrl: play.thumbnailUrl,
    upvotes: play.upvotes,
    downvotes: play.downvotes,
    skipped: play.skipped,
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npx tsx scripts/queup-import-room.ts <export.json>');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }

  const exported = JSON.parse(await readFile(file, 'utf8')) as RoomExport;
  if (exported.source !== 'queup' || !Array.isArray(exported.plays)) {
    console.error(`${file} is not a QueUp room export.`);
    process.exit(1);
  }

  const rows: LegacyRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const play of exported.plays) {
    const row = toRow(play);
    if (!row || seen.has(row.sourceId)) {
      dropped += 1;
      continue;
    }
    seen.add(row.sourceId);
    rows.push(row);
  }

  console.log(`${exported.room.name} (${exported.room.slug}): ${rows.length} plays to import`);
  if (dropped > 0) console.log(`  ${dropped} skipped: no play time, no provider id, or a provider this room cannot play`);

  const db = drizzle({ connection: url });
  const [before] = await db
    .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(legacyPlays);

  for (let start = 0; start < rows.length; start += BATCH) {
    await db.insert(legacyPlays).values(rows.slice(start, start + BATCH)).onConflictDoNothing();
    process.stdout.write(`\r  imported ${Math.min(start + BATCH, rows.length)} / ${rows.length}   `);
  }
  process.stdout.write('\n');

  const [after] = await db
    .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
    .from(legacyPlays);
  const added = (after?.count ?? 0) - (before?.count ?? 0);
  console.log(`Archive now holds ${after?.count ?? 0} plays (${added} new, ${rows.length - added} already there).`);
  process.exit(0);
}

await main();
