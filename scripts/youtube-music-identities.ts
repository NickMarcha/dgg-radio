/**
 * Works out what the room's tracks are actually called, for the dump importers.
 *
 *   npx tsx scripts/youtube-music-identities.ts --out tracks.json
 *   npx tsx scripts/youtube-music-identities.ts --out tracks.json --limit 200
 *   npx tsx scripts/youtube-music-identities.ts --out tracks.json --source discogs
 *
 * The dump importers match on an artist and a title read out of the upload
 * title, which only works when somebody typed `Artist - Title` into YouTube.
 * Just over half of the archive did. The rest — `Sunshine`, `FULLY GASSED`,
 * anything with the artist only in the channel name — cannot be matched at all,
 * however good the catalogue is.
 *
 * YouTube already knows the answer for most of them. Its watch pages carry a
 * Music card naming the recording and the artist a catalogue would recognise,
 * on about 78% of the room's videos, and reading it costs one page load and no
 * API quota. So this fetches those cards and writes a track list whose titles
 * are `Artist - Title` exactly as the importers want to read them.
 *
 * Then:
 *
 *   npx tsx scripts/musicbrainz-dump-import.ts --core ... --derived ... \
 *     --tracks tracks.json --out genres.json
 *   npx tsx scripts/genre-transfer.ts apply --in genres.json
 *
 * which is the same route `genre-transfer.ts` documents, with better names
 * going in. Nothing here asks MusicBrainz or Discogs anything: the whole point
 * is that the dumps can answer if the question is phrased properly, and their
 * APIs are one request a second and therefore a day of running for an archive
 * this size.
 *
 * Answers are cached per video, so a run that is interrupted resumes where it
 * stopped rather than fetching everything again.
 *
 * Only DATABASE_URL is needed, from the environment or `.env`.
 */

import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';
import { describeDatabase } from '../src/server/genre';
import { findMusicCard } from '../src/server/youtube-music';

/**
 * YouTube rate limits this, and finding out costs the whole run: eight at a
 * time answered about 600 of 1,000 pages with 429 and then refused single
 * sequential requests for a while afterwards. One request at a time, a second
 * apart, is what the earlier sampling used without ever being refused.
 *
 * So this is deliberately slow -- about seven hours for a whole archive -- and
 * built to be stopped. Every answer is cached as it arrives, so the cost of
 * stopping is nothing and the cost of a bad guess about the rate is a wait.
 */
const CONCURRENCY = 1;
const REQUEST_SPACING_MS = 1_000;
/** Consecutive refusals before this gives up rather than burning the list. */
const GIVE_UP_AFTER = 20;
const CACHE = join(tmpdir(), 'dggradio-youtube-music-identities');

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Null means asked and told no; undefined means not asked yet. */
type Answer = { artist: string; title: string } | null;

let nextSlot = Promise.resolve();

/** One request at a time, spaced, however many workers are asking. */
function waitForSlot(): Promise<void> {
  const waited = nextSlot;
  nextSlot = waited.then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return waited;
}

/**
 * A refusal is worth waiting out rather than skipping past: the video is fine,
 * and coming back to it later costs one more page load than getting it now.
 */
async function fetchCard(videoId: string): Promise<Answer> {
  for (let attempt = 0; ; attempt += 1) {
    await waitForSlot();
    try {
      const card = await findMusicCard(videoId);
      return card ? { artist: card.artist, title: card.title } : null;
    } catch (error) {
      const refused = error instanceof Error && error.message.includes('429');
      if (!refused || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000 * 2 ** attempt));
    }
  }
}

async function cached(videoId: string): Promise<Answer | undefined> {
  try {
    return JSON.parse(await readFile(join(CACHE, `${videoId}.json`), 'utf8')) as Answer;
  } catch {
    return undefined;
  }
}

async function remember(videoId: string, answer: Answer): Promise<void> {
  await writeFile(join(CACHE, `${videoId}.json`), JSON.stringify(answer), 'utf8');
}

interface Track {
  provider_media_id: string;
  title: string;
}

/**
 * The tracks with no answer from this source yet, most played first, so that
 * stopping early leaves the music people actually hear labelled.
 */
async function unlabelled(
  db: ReturnType<typeof drizzle>,
  source: string,
  limit: number,
): Promise<Track[]> {
  const rows = await db.execute<Track>(sql`
    select known.provider_media_id, min(known.title) as title
    from (
      select provider, provider_media_id, title from media
      union all
      select provider, provider_media_id, title from legacy_plays
    ) as known
    where known.provider = 'youtube'
      and not exists (
        select 1 from track_genres
        where track_genres.provider = 'youtube'
          and track_genres.provider_media_id = known.provider_media_id
          and track_genres.source = ${source}
      )
    group by known.provider_media_id
    order by count(*) desc, known.provider_media_id
    limit ${limit}
  `);
  return rows.rows;
}

async function main(): Promise<void> {
  const outFile = flag('out');
  if (!outFile) {
    console.error('Usage: npx tsx scripts/youtube-music-identities.ts --out tracks.json');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }
  const source = flag('source') ?? 'musicbrainz';
  const limit = Number(flag('limit') ?? 200_000);

  console.log(`Database: ${describeDatabase(url)}`);
  await mkdir(CACHE, { recursive: true });
  const db = drizzle({ connection: url, schema });

  const tracks = await unlabelled(db, source, limit);
  console.log(`${tracks.length.toLocaleString()} tracks with no ${source} answer`);

  const found: { provider: 'youtube'; providerMediaId: string; title: string }[] = [];
  let asked = 0;
  let fromCache = 0;
  let failed = 0;
  const started = Date.now();

  let next = 0;
  let refusals = 0;
  let stopped: string | null = null;
  async function worker(): Promise<void> {
    while (next < tracks.length && !stopped) {
      const track = tracks[next++]!;
      const id = track.provider_media_id;
      let answer = await cached(id);
      if (answer === undefined) {
        try {
          answer = await fetchCard(id);
          await remember(id, answer);
          refusals = 0;
        } catch (error) {
          // A page that cannot be read is not the same as a video with no card,
          // so it is left uncached and a later run will try it again. A run of
          // them means YouTube has stopped answering, and carrying on would
          // spend the whole list learning that once per track.
          failed += 1;
          refusals += 1;
          if (refusals >= GIVE_UP_AFTER) {
            stopped = error instanceof Error ? error.message : String(error);
          }
          continue;
        }
        asked += 1;
      } else {
        fromCache += 1;
      }
      if (answer) {
        found.push({
          provider: 'youtube',
          providerMediaId: id,
          // Exactly the shape the importers split on.
          title: `${answer.artist} - ${answer.title}`,
        });
      }
      const done = asked + fromCache + failed;
      if (done % 250 === 0) {
        const rate = asked / ((Date.now() - started) / 1000);
        process.stdout.write(
          `\r  ${done.toLocaleString()} / ${tracks.length.toLocaleString()}, ` +
            `${found.length.toLocaleString()} named, ${rate.toFixed(1)} fetched/s   `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  await writeFile(outFile, JSON.stringify({ tracks: found }), 'utf8');

  if (stopped) {
    console.error(
      `Stopped after ${GIVE_UP_AFTER} refusals in a row: ${stopped}\n` +
        'Everything read so far is cached and written. Wait a while, then run it again.',
    );
  }

  const considered = asked + fromCache;
  const rate = considered ? ((found.length / considered) * 100).toFixed(1) : '0.0';
  console.log(
    `${outFile}: ${found.length.toLocaleString()} named of ${considered.toLocaleString()} ` +
      `read (${rate}%), ${fromCache.toLocaleString()} from cache, ` +
      `${failed.toLocaleString()} unreadable`,
  );
  process.exit(0);
}

await main();
