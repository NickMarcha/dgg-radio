/**
 * Labels the room's tracks with genre from the monthly Discogs masters dump.
 *
 *   npx tsx scripts/discogs-dump-import.ts discogs_20260901_masters.xml.gz
 *
 * Discogs embeds YouTube video ids in its masters -- 5.76 million of them --
 * and joining on that id is exact: no MusicBrainz link, no fuzzy artist and
 * title match, and no Discogs API request. It reaches 30.8% of this room's
 * archive, where going through MusicBrainz's Discogs relations reaches 1.4%.
 * The API cannot be queried by video id at all, so the dump is not a cheaper
 * route to this data, it is the only one.
 *
 * Get the dump from https://data.discogs.com/ -- `discogs_YYYYMM01_masters.xml.gz`,
 * about 600 MB. It is published CC0, so nothing about the Discogs API terms
 * applies to what this writes.
 *
 * Run it again with a newer dump to pick up masters Discogs has added. Every
 * track is re-considered each time: a scan of the whole dump costs the same
 * whether or not a track was answered last month, so there is nothing to gain
 * from remembering which ones missed.
 *
 * By default it reads the room's tracks from the database and writes the
 * answers back to it. With `--tracks` and `--out` it does neither and works
 * entirely from files, so the dump never has to sit on the machine that runs
 * the room. `genre-transfer.ts` makes the one file and applies the other.
 *
 * DATABASE_URL is needed unless both of those are given.
 */

import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import * as schema from '../src/server/db/schema';
import type { StoredGenre } from '../src/server/genre';
import { storeGenres } from '../src/server/genre';
import type { GenreFile, TrackList } from './genre-transfer';

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

/** Rows per insert, well inside PostgreSQL's parameter limit at nine columns. */
const BATCH = 1_000;

/**
 * A video id can sit on several masters: the original album, a best-of, a later
 * compilation. Keeping a few of them is what makes disagreement visible rather
 * than picking one at random and calling it the answer.
 */
const MAX_MASTERS_PER_VIDEO = 8;

interface Master {
  masterId: string;
  genres: string[];
  styles: string[];
  artists: string[];
  title: string | null;
}

/** One track the room knows about, from either history. */
interface Track {
  providerMediaId: string;
  title: string;
}

/**
 * Only the `src` attribute of a `<video>` counts as a link between a master and
 * a video. Descriptions are free text that routinely quote unrelated YouTube
 * URLs, so scanning the whole record invents matches -- a Beatles upload turned
 * up on a gospel quartet master that merely mentioned it.
 */
function youtubeIds(masterXml: string): string[] {
  const ids = new Set<string>();
  for (const match of masterXml.matchAll(
    /<video\b[^>]*\bsrc="[^"]*?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g,
  )) {
    ids.add(match[1]!);
  }
  return [...ids];
}

function tagValues(masterXml: string, container: string, item: string): string[] {
  const block = masterXml.match(new RegExp(`<${container}>(.*?)</${container}>`, 's'));
  if (!block?.[1]) return [];
  return [...block[1].matchAll(new RegExp(`<${item}>(.*?)</${item}>`, 'gs'))].map((match) =>
    (match[1] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#13;/g, ''),
  );
}

/**
 * Streams the dump, keeping only masters that carry a video this room has
 * played. Keeping all 5.7 million embedded ids exhausts a 4 GB Node heap, and
 * every one of them but these would be discarded anyway.
 */
async function buildIndex(
  dumpPath: string,
  wanted: Set<string>,
): Promise<Map<string, Master[]>> {
  const index = new Map<string, Master[]>();
  const lines = createInterface({
    input: createReadStream(dumpPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let masters = 0;
  let buffer = '';

  for await (const line of lines) {
    // Discogs writes one <master> per line, but tolerate a record split across
    // several rather than trusting the format to stay that way.
    buffer = buffer ? `${buffer}${line}` : line;
    if (!buffer.includes('</master>')) {
      if (!buffer.includes('<master ')) buffer = '';
      continue;
    }
    const record = buffer;
    buffer = '';

    const id = record.match(/<master id="(\d+)"/)?.[1];
    if (!id) continue;
    masters += 1;
    if (masters % 250_000 === 0) {
      process.stdout.write(`\r  ${masters.toLocaleString()} masters scanned   `);
    }

    const relevant = youtubeIds(record).filter((videoId) => wanted.has(videoId));
    if (relevant.length === 0) continue;

    const master: Master = {
      masterId: id,
      genres: tagValues(record, 'genres', 'genre'),
      styles: tagValues(record, 'styles', 'style'),
      artists: tagValues(record, 'artists', 'name'),
      title: record.match(/<title>(.*?)<\/title>/s)?.[1] ?? null,
    };
    for (const videoId of relevant) {
      const existing = index.get(videoId);
      if (!existing) index.set(videoId, [master]);
      else if (existing.length < MAX_MASTERS_PER_VIDEO) existing.push(master);
    }
  }

  process.stdout.write(`\r  ${masters.toLocaleString()} masters scanned   \n`);
  return index;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('en-US')
    // Discogs disambiguates duplicate artist names with a trailing "(2)".
    .replace(/\(\d+\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function genreFingerprint(master: Master): string {
  return [...master.genres].sort().join('|');
}

/**
 * Picks which master describes the track, and says whether the choice was a
 * real one. Two rules were measured against the 2,256 tracks whose masters
 * disagree; together they settle 827 of them and neither is strong, because
 * the conflicts are mostly genuine disagreement inside Discogs rather than a
 * selection problem.
 *
 * A residue of mislabelling survives any rule. The Beatles' `Happiness Is A
 * Warm Gun` is attached by real `<video src>` links to a Various-Artists
 * compilation and to a gospel quartet record, and neither of them is The
 * Beatles. Nothing rescues a track whose every candidate is wrong, so a track
 * still in conflict after both rules keeps its answer and is marked ambiguous.
 */
function chooseMaster(
  masters: Master[],
  title: string,
): { master: Master; ambiguous: boolean } | null {
  const labelled = masters.filter((master) => master.genres.length > 0);
  if (labelled.length === 0) return null;

  const agreed = new Set(labelled.map(genreFingerprint)).size === 1;
  if (agreed) return { master: labelled[0]!, ambiguous: false };

  // A compilation carries whatever the compilation is about, which is rarely
  // what the track is. Prefer anything credited to an actual artist.
  const credited = labelled.filter(
    (master) => !master.artists.some((artist) => normalize(artist) === 'various'),
  );
  const candidates = credited.length > 0 ? credited : labelled;

  // Then prefer a master whose artist the upload names, which is the only
  // check available without asking Discogs anything further.
  const playTitle = normalize(title);
  const named = candidates.filter((master) =>
    master.artists.some((artist) => {
      const artistName = normalize(artist);
      return artistName.length > 2 && playTitle.includes(artistName);
    }),
  );
  const chosen = named.length > 0 ? named : candidates;

  return {
    master: chosen[0]!,
    ambiguous: new Set(chosen.map(genreFingerprint)).size > 1,
  };
}

async function main(): Promise<void> {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error('Usage: npx tsx scripts/discogs-dump-import.ts <discogs_YYYYMM01_masters.xml.gz>');
    process.exit(1);
  }
  // Handed its tracks and asked for a file, this needs no database at all,
  // which is how the deployment host gets these genres without the dump.
  const tracksFile = flag('tracks');
  const outFile = flag('out');
  const url = process.env.DATABASE_URL;
  if ((!tracksFile || !outFile) && !url) {
    console.error(
      'DATABASE_URL is required unless both --tracks and --out are given. ' +
        'See scripts/genre-transfer.ts for making the one and applying the other.',
    );
    process.exit(1);
  }

  const db = url ? drizzle({ connection: url, schema }) : null;

  // Both histories, because the archive is most of what there is to label and
  // its tracks have no `media` row to hang anything off.
  const known = tracksFile
    ? {
        rows: (JSON.parse(await readFile(tracksFile, 'utf8')) as TrackList).tracks
          .filter((track) => track.provider === 'youtube')
          .map((track) => ({ provider_media_id: track.providerMediaId, title: track.title })),
      }
    : await db!.execute<{ provider_media_id: string; title: string }>(sql`
        select provider_media_id, min(title) as title
        from (
          select provider, provider_media_id, title from media
          union all
          select provider, provider_media_id, title from legacy_plays
        ) as played
        where provider = 'youtube'
        group by provider_media_id
      `);
  const tracks = new Map<string, Track>(
    known.rows.map((row) => [
      row.provider_media_id,
      { providerMediaId: row.provider_media_id, title: row.title },
    ]),
  );
  if (tracks.size === 0) {
    console.log('No YouTube tracks to label yet.');
    process.exit(0);
  }

  console.log(`Scanning ${dumpPath} against ${tracks.size.toLocaleString()} YouTube tracks`);
  const index = await buildIndex(dumpPath, new Set(tracks.keys()));

  const rows: StoredGenre[] = [];
  let ambiguous = 0;
  for (const [videoId, masters] of index) {
    const track = tracks.get(videoId);
    if (!track) continue;
    const chosen = chooseMaster(masters, track.title);
    if (!chosen) continue;
    if (chosen.ambiguous) ambiguous += 1;
    rows.push({
      provider: 'youtube',
      providerMediaId: videoId,
      source: 'discogs',
      // A master is a release rather than the recording, which is as close to
      // the track as this join gets.
      level: 'master',
      genres: chosen.master.genres,
      styles: chosen.master.styles,
      sourceEntityId: chosen.master.masterId,
      sourceUrl: `https://www.discogs.com/master/${chosen.master.masterId}`,
      ambiguous: chosen.ambiguous,
    });
  }

  if (outFile) {
    await writeFile(
      outFile,
      JSON.stringify({ generatedAt: new Date().toISOString(), rows } satisfies GenreFile),
      'utf8',
    );
    console.log(`  wrote ${rows.length.toLocaleString()} answers to ${outFile}`);
  } else {
    for (let start = 0; start < rows.length; start += BATCH) {
      await storeGenres(rows.slice(start, start + BATCH), db!);
      process.stdout.write(`\r  stored ${Math.min(start + BATCH, rows.length)} / ${rows.length}   `);
    }
    process.stdout.write('\n');
  }

  const percent = ((rows.length / tracks.size) * 100).toFixed(1);
  console.log(
    `Labelled ${rows.length.toLocaleString()} of ${tracks.size.toLocaleString()} tracks (${percent}%), ` +
      `${ambiguous.toLocaleString()} of them from masters that disagree.`,
  );
  process.exit(0);
}

await main();
