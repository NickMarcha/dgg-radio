/**
 * Labels the room's tracks with genre from the MusicBrainz database dumps.
 *
 *   npx tsx scripts/musicbrainz-dump-import.ts \
 *     --core mbdump.tar.bz2 --derived mbdump-derived.tar.bz2
 *
 * By default it reads the room's tracks from the database and writes the
 * answers back to it. With `--tracks` and `--out` it does neither, and works
 * entirely from files — which is how the deployment host gets these genres
 * without ever seeing 7.6 GB of dumps. `genre-transfer.ts` makes the one file
 * and applies the other.
 *
 * This is a backfill, not part of the room. It exists because the per-track
 * pass in `enrich-genres.ts` spends about four requests a track against a
 * one-a-second limit, which is days of running for an archive this size. The
 * dumps answer the same questions offline, so the whole archive can be labelled
 * in one sitting and the temporary cost — several gigabytes of download and
 * extraction — goes away afterwards.
 *
 * What it does *not* do is join on an embedded YouTube id the way the Discogs
 * import does. That was measured: MusicBrainz links only 18 of the room's 100
 * most played tracks to a recording by URL, against Discogs' 30.8% across the
 * whole archive. Those 18 are still taken, exactly, because they cost nothing
 * once the dump is open; everything else is matched on artist and title read
 * out of the upload title, which is fuzzy and therefore checked before it is
 * believed.
 *
 * Genre in MusicBrainz is a tag whose name is also in the `genre` table, and it
 * sits at three levels. All three are read, and the level is stored, because an
 * artist genre describes a catalogue rather than a track and must never be
 * shown as though it did.
 *
 * Needs `bzip2` and `tar` on the path, which Git Bash provides on Windows, and
 * DATABASE_URL unless both `--tracks` and `--out` are given.
 */

import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';
import { storeGenres, type StoredGenre } from '../src/server/genre';
import type { GenreFile, TrackList } from './genre-transfer';


const SCHEMA_URL =
  'https://raw.githubusercontent.com/metabrainz/musicbrainz-server/master/admin/sql/CreateTables.sql';

/** Where the extracted tables and the schema are kept between runs. */
const workDirectory = join(tmpdir(), 'dggradio-musicbrainz-dump');

/**
 * Only these tables are pulled out of the archives. `track` is the largest
 * table MusicBrainz publishes and is here for one reason: it is the only way
 * from a recording to the release it appeared on, and the release group is
 * where most genre actually lives.
 */
const CORE_TABLES = [
  'recording',
  'artist_credit_name',
  'artist',
  'track',
  'medium',
  'release',
  'release_group',
  'genre',
  'url',
  'l_recording_url',
];
const DERIVED_TABLES = ['tag', 'recording_tag', 'release_group_tag', 'artist_tag'];

/** How many recordings to keep for one title before it is clearly too common. */
const MAX_CANDIDATES_PER_TITLE = 40;
/** Rows per insert, well inside PostgreSQL's parameter limit. */
const BATCH = 1_000;

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which column is which, read from MusicBrainz's own `CreateTables.sql`.
 *
 * The dumps are headerless `COPY` output, so a wrong guess about column order
 * does not fail, it silently labels everything with somebody else's data. This
 * is the one thing in here worth being pedantic about.
 */
async function columnIndexes(schemaPath: string): Promise<Map<string, Map<string, number>>> {
  const source = await readFile(schemaPath, 'utf8');
  const tables = new Map<string, Map<string, number>>();

  // Read line by line rather than matching a whole block. The definitions are
  // full of parentheses -- `VARCHAR(255)`, `CHECK (...)`, and a `-- replicate
  // (verbose)` comment on the CREATE line itself -- so anything that tries to
  // find the closing bracket by pattern quietly matches the wrong tables.
  let current: Map<string, number> | null = null;
  for (const line of source.split('\n')) {
    const opening = line.match(/^CREATE TABLE\s+([a-z_][a-z0-9_]*)\s*\(/);
    if (opening?.[1]) {
      current = new Map<string, number>();
      tables.set(opening[1], current);
      continue;
    }
    if (!current) continue;
    if (/^\);/.test(line)) {
      current = null;
      continue;
    }
    // Column names carry digits — `entity0` and `entity1` are how every
    // relationship table names its two ends.
    const column = line.match(/^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/);
    if (column?.[1]) current.set(column[1], current.size);
  }
  return tables;
}

/** `COPY` text format: tab separated, `\N` for null, backslash escapes. */
function parseRow(line: string): (string | null)[] {
  return line.split('\t').map((value) => {
    if (value === '\\N') return null;
    if (!value.includes('\\')) return value;
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  });
}

/**
 * One table, a row at a time. These files run to several gigabytes and tens of
 * millions of rows, so the progress line reports heap as well as position: the
 * failure mode here is not slowness, it is a filter that turns out to keep more
 * than it looks like it keeps.
 */
async function scan(
  path: string,
  onRow: (row: (string | null)[]) => void,
): Promise<number> {
  const table = path.split(/[\/]/).at(-1);
  let rows = 0;
  const lines = createInterface({
    input: createReadStream(path, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    rows += 1;
    if (rows % 5_000_000 === 0) {
      const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      process.stdout.write(`\r    ${table}: ${(rows / 1e6).toFixed(0)}M rows, ${heap} MB heap   `);
    }
    onRow(parseRow(line));
  }
  if (rows >= 5_000_000) process.stdout.write('\n');
  return rows;
}

/** One pass over an archive, writing out only the tables this needs. */
async function extract(archive: string, tables: string[]): Promise<void> {
  const missing: string[] = [];
  for (const table of tables) {
    if (!(await exists(join(workDirectory, 'mbdump', table)))) missing.push(table);
  }
  if (missing.length === 0) {
    console.log(`  already extracted: ${tables.join(', ')}`);
    return;
  }

  console.log(`  extracting ${missing.length} tables from ${archive}`);
  // Piped rather than `tar -xjf`, because the tar Git Bash ships does not
  // decompress bzip2 itself and fails with a bare "child returned status 128".
  await new Promise<void>((resolve, reject) => {
    const decompress = spawn('bzip2', ['-dc', archive], { stdio: ['ignore', 'pipe', 'inherit'] });
    const untar = spawn(
      'tar',
      ['-xf', '-', '-C', workDirectory, ...missing.map((table) => `mbdump/${table}`)],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    decompress.on('error', reject);
    untar.on('error', reject);
    decompress.stdout.pipe(untar.stdin);
    untar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code} while reading ${archive}`));
    });
  });
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The artist and the track out of an upload title. Most music uploads are named
 * `Artist - Title`, and the qualifiers a catalogue does not carry are stripped
 * so that `Song (2011 Remaster)` can match `Song`.
 */
function readUploadTitle(uploadTitle: string): { artist: string; title: string } | null {
  const qualifiers = [
    /\s*[[(](?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?[\])]/giu,
    /\s*[[(](?:official(?:\s+music)?\s+video|official\s+audio|official\s+visuali[sz]er|lyric\s+video|visuali[sz]er|hd\s+upscale|audio|video)[\])]/giu,
    /\s*[[(](?:feat(?:uring)?\.?|ft\.?)\s+[^\])]+[\])]/giu,
    /\s*[[(]\d{4}[\])]/gu,
  ];
  const cleaned = qualifiers.reduce((title, pattern) => title.replace(pattern, ''), uploadTitle);
  const split = cleaned.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,})$/);
  if (!split?.[1] || !split[2]) return null;
  return { artist: normalize(split[1]), title: normalize(split[2]) };
}

interface Wanted {
  videoId: string;
  artist: string;
  title: string;
}

async function main(): Promise<void> {
  const core = flag('core');
  const derived = flag('derived');
  if (!core || !derived) {
    console.error(
      'Usage: npx tsx scripts/musicbrainz-dump-import.ts --core mbdump.tar.bz2 --derived mbdump-derived.tar.bz2',
    );
    process.exit(1);
  }
  // A run that is handed its tracks and asked for a file needs no database at
  // all, which is the point: the machine with the dumps on it is not the
  // machine with the room on it.
  const tracksFile = flag('tracks');
  const outFile = flag('out');
  const databaseUrl = process.env.DATABASE_URL;
  if ((!tracksFile || !outFile) && !databaseUrl) {
    console.error(
      'DATABASE_URL is required unless both --tracks and --out are given. ' +
        'See scripts/genre-transfer.ts for making the one and applying the other.',
    );
    process.exit(1);
  }

  await mkdir(workDirectory, { recursive: true });

  const schemaPath = join(workDirectory, 'CreateTables.sql');
  if (!(await exists(schemaPath))) {
    console.log('Fetching the MusicBrainz schema to read column order from');
    const response = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`The schema could not be fetched: ${response.status}`);
    await writeFile(schemaPath, await response.text(), 'utf8');
  }
  const columns = await columnIndexes(schemaPath);
  const at = (table: string, column: string): number => {
    const index = columns.get(table)?.get(column);
    if (index === undefined) throw new Error(`${table}.${column} is not in the schema`);
    return index;
  };
  const table = (name: string) => join(workDirectory, 'mbdump', name);

  console.log('Opening the dumps');
  await extract(derived, DERIVED_TABLES);
  await extract(core, CORE_TABLES);

  // Every YouTube track either history knows about, with the best guess at
  // what a catalogue would call it.
  const db = databaseUrl ? drizzle({ connection: databaseUrl, schema }) : null;
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

  const wantedByTitle = new Map<string, Wanted[]>();
  const wantedUrls = new Map<string, string>();
  for (const row of known.rows) {
    for (const spelling of [
      `https://www.youtube.com/watch?v=${row.provider_media_id}`,
      `https://youtu.be/${row.provider_media_id}`,
    ]) {
      wantedUrls.set(spelling, row.provider_media_id);
    }
    const read = readUploadTitle(row.title);
    if (!read) continue;
    const list = wantedByTitle.get(read.title) ?? [];
    list.push({ videoId: row.provider_media_id, artist: read.artist, title: read.title });
    wantedByTitle.set(read.title, list);
  }
  console.log(
    `${known.rows.length.toLocaleString()} YouTube tracks, ` +
      `${wantedByTitle.size.toLocaleString()} of them with a readable "Artist - Title"`,
  );

  // 1. The URLs MusicBrainz happens to know, which are exact and free.
  const urlToVideo = new Map<string, string>();
  await scan(table('url'), (row) => {
    const url = row[at('url', 'url')];
    const video = url ? wantedUrls.get(url) : undefined;
    if (video) urlToVideo.set(row[at('url', 'id')]!, video);
  });
  const exactRecordingToVideo = new Map<string, string>();
  await scan(table('l_recording_url'), (row) => {
    const video = urlToVideo.get(row[at('l_recording_url', 'entity1')]!);
    if (video) exactRecordingToVideo.set(row[at('l_recording_url', 'entity0')]!, video);
  });
  console.log(`  ${exactRecordingToVideo.size.toLocaleString()} tracks linked by URL, exactly`);

  // 2. Recordings whose title one of ours could be, plus the exact ones.
  interface Candidate {
    recordingId: string;
    gid: string;
    name: string;
    artistCredit: string;
  }
  const candidatesByTitle = new Map<string, Candidate[]>();
  const exactCandidates = new Map<string, Candidate>();
  const recordingRows = await scan(table('recording'), (row) => {
    const id = row[at('recording', 'id')]!;
    const name = row[at('recording', 'name')] ?? '';
    const candidate: Candidate = {
      recordingId: id,
      gid: row[at('recording', 'gid')]!,
      name,
      artistCredit: row[at('recording', 'artist_credit')]!,
    };
    if (exactRecordingToVideo.has(id)) exactCandidates.set(id, candidate);

    const key = normalize(name);
    const wanted = wantedByTitle.get(key);
    if (!wanted) return;
    const list = candidatesByTitle.get(key) ?? [];
    if (list.length >= MAX_CANDIDATES_PER_TITLE) return;
    list.push(candidate);
    candidatesByTitle.set(key, list);
  });
  console.log(
    `  ${recordingRows.toLocaleString()} recordings scanned, ` +
      `${candidatesByTitle.size.toLocaleString()} titles matched`,
  );

  // 3. Who those recordings are credited to.
  const creditsWanted = new Set<string>();
  for (const list of candidatesByTitle.values()) {
    for (const candidate of list) creditsWanted.add(candidate.artistCredit);
  }
  for (const candidate of exactCandidates.values()) creditsWanted.add(candidate.artistCredit);

  const creditNames = new Map<string, string[]>();
  const creditArtists = new Map<string, string[]>();
  await scan(table('artist_credit_name'), (row) => {
    const credit = row[at('artist_credit_name', 'artist_credit')]!;
    if (!creditsWanted.has(credit)) return;
    creditNames.set(credit, [...(creditNames.get(credit) ?? []), row[at('artist_credit_name', 'name')] ?? '']);
    creditArtists.set(credit, [
      ...(creditArtists.get(credit) ?? []),
      row[at('artist_credit_name', 'artist')]!,
    ]);
  });

  // 4. Settle which recording each track is. A URL link is taken as given; a
  //    title match has to agree on the artist as well.
  const chosen = new Map<string, Candidate>();
  for (const [recordingId, videoId] of exactRecordingToVideo) {
    const candidate = exactCandidates.get(recordingId);
    if (candidate) chosen.set(videoId, candidate);
  }
  let byTitle = 0;
  for (const [title, wantedList] of wantedByTitle) {
    const candidates = candidatesByTitle.get(title);
    if (!candidates) continue;
    for (const wanted of wantedList) {
      if (chosen.has(wanted.videoId)) continue;
      const match = candidates.find((candidate) =>
        (creditNames.get(candidate.artistCredit) ?? []).some(
          (name) => normalize(name) === wanted.artist,
        ),
      );
      if (match) {
        chosen.set(wanted.videoId, match);
        byTitle += 1;
      }
    }
  }
  console.log(
    `  ${chosen.size.toLocaleString()} tracks identified ` +
      `(${exactRecordingToVideo.size.toLocaleString()} by URL, ${byTitle.toLocaleString()} by artist and title)`,
  );
  if (chosen.size === 0) {
    console.log('Nothing to label.');
    process.exit(0);
  }

  // 5. Which tags are genres. MusicBrainz keeps genre as a tag whose name is
  //    also a row in `genre`, so the two have to be read together.
  const genreNames = new Set<string>();
  await scan(table('genre'), (row) => {
    genreNames.add((row[at('genre', 'name')] ?? '').toLocaleLowerCase('en-US'));
  });
  const genreTags = new Map<string, string>();
  await scan(table('tag'), (row) => {
    const name = row[at('tag', 'name')] ?? '';
    if (genreNames.has(name.toLocaleLowerCase('en-US'))) {
      genreTags.set(row[at('tag', 'id')]!, name);
    }
  });
  console.log(`  ${genreTags.size.toLocaleString()} of MusicBrainz's tags are genres`);

  const wantedRecordings = new Map<string, string>();
  for (const [videoId, candidate] of chosen) wantedRecordings.set(candidate.recordingId, videoId);

  // 6. Genre on the recording itself, which is the most precise and the rarest.
  const recordingGenres = new Map<string, string[]>();
  await scan(table('recording_tag'), (row) => {
    const recording = row[at('recording_tag', 'recording')]!;
    if (!wantedRecordings.has(recording)) return;
    const name = genreTags.get(row[at('recording_tag', 'tag')]!);
    const count = Number(row[at('recording_tag', 'count')] ?? 0);
    if (!name || count <= 0) return;
    recordingGenres.set(recording, [...(recordingGenres.get(recording) ?? []), name]);
  });

  // 7. The release group each recording appeared on, which is where most of
  //    MusicBrainz's genre actually is. Four tables to walk, each filtered to
  //    what the step before it kept.
  const recordingToMedium = new Map<string, string>();
  await scan(table('track'), (row) => {
    const recording = row[at('track', 'recording')]!;
    if (!wantedRecordings.has(recording) || recordingToMedium.has(recording)) return;
    recordingToMedium.set(recording, row[at('track', 'medium')]!);
  });
  const mediumWanted = new Set(recordingToMedium.values());
  const mediumToRelease = new Map<string, string>();
  await scan(table('medium'), (row) => {
    const id = row[at('medium', 'id')]!;
    if (mediumWanted.has(id)) mediumToRelease.set(id, row[at('medium', 'release')]!);
  });
  const releaseWanted = new Set(mediumToRelease.values());
  const releaseToGroup = new Map<string, string>();
  await scan(table('release'), (row) => {
    const id = row[at('release', 'id')]!;
    if (releaseWanted.has(id)) releaseToGroup.set(id, row[at('release', 'release_group')]!);
  });
  const groupWanted = new Set(releaseToGroup.values());
  const groupGids = new Map<string, string>();
  await scan(table('release_group'), (row) => {
    const id = row[at('release_group', 'id')]!;
    if (groupWanted.has(id)) groupGids.set(id, row[at('release_group', 'gid')]!);
  });
  const groupGenres = new Map<string, string[]>();
  await scan(table('release_group_tag'), (row) => {
    const group = row[at('release_group_tag', 'release_group')]!;
    if (!groupWanted.has(group)) return;
    const name = genreTags.get(row[at('release_group_tag', 'tag')]!);
    const count = Number(row[at('release_group_tag', 'count')] ?? 0);
    if (!name || count <= 0) return;
    groupGenres.set(group, [...(groupGenres.get(group) ?? []), name]);
  });

  // 8. The artist, which nearly always has a genre and nearly always says less.
  const artistWanted = new Set<string>();
  for (const candidate of chosen.values()) {
    for (const artist of creditArtists.get(candidate.artistCredit) ?? []) artistWanted.add(artist);
  }
  const artistGids = new Map<string, string>();
  await scan(table('artist'), (row) => {
    const id = row[at('artist', 'id')]!;
    if (artistWanted.has(id)) artistGids.set(id, row[at('artist', 'gid')]!);
  });
  const artistGenres = new Map<string, string[]>();
  await scan(table('artist_tag'), (row) => {
    const artist = row[at('artist_tag', 'artist')]!;
    if (!artistWanted.has(artist)) return;
    const name = genreTags.get(row[at('artist_tag', 'tag')]!);
    const count = Number(row[at('artist_tag', 'count')] ?? 0);
    if (!name || count <= 0) return;
    artistGenres.set(artist, [...(artistGenres.get(artist) ?? []), name]);
  });

  // 9. The closest thing to the track that anyone knows, and where it came
  //    from, so a coarse answer can be shown as the coarse thing it is.
  const rows: StoredGenre[] = [];
  const levels = { recording: 0, release_group: 0, artist: 0, nothing: 0 };
  for (const [videoId, candidate] of chosen) {
    const base = {
      provider: 'youtube' as const,
      providerMediaId: videoId,
      source: 'musicbrainz' as const,
      styles: [],
      ambiguous: false,
    };

    const fromRecording = recordingGenres.get(candidate.recordingId);
    if (fromRecording?.length) {
      levels.recording += 1;
      rows.push({
        ...base,
        level: 'recording',
        genres: [...new Set(fromRecording)],
        sourceEntityId: candidate.gid,
        sourceUrl: `https://musicbrainz.org/recording/${candidate.gid}`,
      });
      continue;
    }

    const medium = recordingToMedium.get(candidate.recordingId);
    const release = medium ? mediumToRelease.get(medium) : undefined;
    const group = release ? releaseToGroup.get(release) : undefined;
    const fromGroup = group ? groupGenres.get(group) : undefined;
    if (group && fromGroup?.length) {
      levels.release_group += 1;
      rows.push({
        ...base,
        level: 'release_group',
        genres: [...new Set(fromGroup)],
        sourceEntityId: groupGids.get(group) ?? null,
        sourceUrl: `https://musicbrainz.org/release-group/${groupGids.get(group)}`,
      });
      continue;
    }

    const artist = (creditArtists.get(candidate.artistCredit) ?? []).find((id) =>
      artistGenres.has(id),
    );
    if (artist) {
      levels.artist += 1;
      rows.push({
        ...base,
        level: 'artist',
        genres: [...new Set(artistGenres.get(artist)!)],
        sourceEntityId: artistGids.get(artist) ?? null,
        sourceUrl: `https://musicbrainz.org/artist/${artistGids.get(artist)}`,
      });
      continue;
    }

    // Identified and genuinely unlabelled. Worth recording so the per-track
    // pass does not spend four requests learning the same nothing.
    levels.nothing += 1;
    rows.push({
      ...base,
      level: null,
      genres: [],
      sourceEntityId: candidate.gid,
      sourceUrl: null,
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

  const labelled = levels.recording + levels.release_group + levels.artist;
  const aboutTheTrack = levels.recording + levels.release_group;
  const percent = (value: number) => ((value / Math.max(known.rows.length, 1)) * 100).toFixed(1);
  console.log(
    `\nLabelled ${labelled.toLocaleString()} of ${known.rows.length.toLocaleString()} tracks ` +
      `(${percent(labelled)}%), ${aboutTheTrack.toLocaleString()} of them about the track ` +
      `(${percent(aboutTheTrack)}%).\n` +
      `  recording ${levels.recording.toLocaleString()} · ` +
      `release group ${levels.release_group.toLocaleString()} · ` +
      `artist ${levels.artist.toLocaleString()} · ` +
      `identified but unlabelled ${levels.nothing.toLocaleString()}`,
  );
  process.exit(0);
}

await main();
