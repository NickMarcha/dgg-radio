/**
 * PROTOTYPE: measure how much of the room's archive the Discogs monthly masters
 * dump can label with a genre, using the YouTube video ids that Discogs itself
 * embeds in each master's <videos> element.
 *
 * This is an exact join on video id. It needs no MusicBrainz link, no fuzzy
 * artist and title matching, and no Discogs API request, so none of the API
 * terms about staleness or attribution apply to the dump data it reads.
 *
 * The dump is CC0. Download it once from https://data.discogs.com/ into the OS
 * temporary directory and pass the path.
 *
 *   npx tsx scripts/discogs-dump-coverage.prototype.ts \
 *     [masters.xml.gz] [queup-export.json]
 */

import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const defaultDump = join(tmpdir(), 'dggradio-discogs-masters-20260901.xml.gz');
const defaultExport = join(tmpdir(), 'dggradio-queup-dgg-radio-full.json');
const outputFile = join(tmpdir(), 'dggradio-discogs-dump-coverage.json');

interface Play {
  provider: string;
  providerMediaId: string;
  title: string;
  plays?: number;
}

interface MasterGenres {
  masterId: string;
  genres: string[];
  styles: string[];
  artists: string[];
  title: string | null;
}

/**
 * Discogs writes one <master> per line in the dump, which keeps this a stream.
 *
 * Only the src attribute of a <video> counts as a link between this master and
 * the video. Video descriptions are free text and routinely quote unrelated
 * YouTube URLs, so scanning the whole record invents matches: a Beatles upload
 * turned up on a gospel quartet master that merely mentioned it.
 */
function youtubeIds(masterXml: string): string[] {
  const ids = new Set<string>();
  for (const match of masterXml.matchAll(
    /<video\b[^>]*\bsrc="[^"]*?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g,
  )) {
    ids.add(match[1]);
  }
  return [...ids];
}

function tagValues(masterXml: string, container: string, item: string): string[] {
  const block = masterXml.match(new RegExp(`<${container}>(.*?)</${container}>`, 's'));
  if (!block) return [];
  return [...block[1].matchAll(new RegExp(`<${item}>(.*?)</${item}>`, 'gs'))].map((match) =>
    match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#13;/g, ''),
  );
}

/**
 * A video id can appear on several masters: an album, a later compilation, a
 * best-of. Keeping them all is what lets the caller see when Discogs disagrees
 * with itself about a track's genre.
 */
const MAX_MASTERS_PER_VIDEO = 8;

async function buildIndex(dumpPath: string, wanted: Set<string>): Promise<Map<string, MasterGenres[]>> {
  const index = new Map<string, MasterGenres[]>();
  const stream = createReadStream(dumpPath).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let masters = 0;
  let mastersWithVideos = 0;
  let mastersWithGenre = 0;
  let videoIdsSeen = 0;
  let buffer = '';

  for await (const line of lines) {
    // Most masters are one line, but tolerate records split across lines.
    buffer = buffer ? `${buffer}${line}` : line;
    if (!buffer.includes('</master>')) {
      if (!buffer.includes('<master ')) buffer = '';
      continue;
    }

    const record = buffer;
    buffer = '';

    const idMatch = record.match(/<master id="(\d+)"/);
    if (!idMatch) continue;
    masters += 1;
    if (masters % 250_000 === 0) console.log(`${masters.toLocaleString()} masters scanned`);

    const genres = tagValues(record, 'genres', 'genre');
    if (genres.length > 0) mastersWithGenre += 1;

    const ids = youtubeIds(record);
    if (ids.length === 0) continue;
    mastersWithVideos += 1;
    videoIdsSeen += ids.length;

    // Keeping every master for all 5.7M embedded video ids exhausts the heap,
    // and all but the room's own tracks would be discarded anyway.
    const relevant = ids.filter((id) => wanted.has(id));
    if (relevant.length === 0) continue;

    const styles = tagValues(record, 'styles', 'style');
    const artists = tagValues(record, 'artists', 'name');
    const titleMatch = record.match(/<title>(.*?)<\/title>/s);
    const entry = {
      masterId: idMatch[1],
      genres,
      styles,
      artists,
      title: titleMatch ? titleMatch[1] : null,
    };

    for (const id of relevant) {
      const existing = index.get(id);
      if (!existing) index.set(id, [entry]);
      else if (existing.length < MAX_MASTERS_PER_VIDEO) existing.push(entry);
    }
  }

  console.log(
    `Indexed ${masters.toLocaleString()} masters, ${mastersWithVideos.toLocaleString()} with videos, ` +
      `${mastersWithGenre.toLocaleString()} with a genre, ${videoIdsSeen.toLocaleString()} embedded video ids, ` +
      `${index.size.toLocaleString()} of them played in this room`,
  );
  return index;
}

async function main(): Promise<void> {
  const dumpPath = process.argv[2] ?? defaultDump;
  const exportPath = process.argv[3] ?? defaultExport;

  const exported = JSON.parse(await readFile(exportPath, 'utf8')) as { plays: Play[] };

  // Collapse plays to distinct YouTube tracks, keeping how often each was played
  // so coverage can be weighted by what the room actually listened to.
  const tracks = new Map<string, { title: string; plays: number }>();
  for (const play of exported.plays) {
    if (play.provider !== 'youtube' || !play.providerMediaId) continue;
    const existing = tracks.get(play.providerMediaId);
    if (existing) existing.plays += 1;
    else tracks.set(play.providerMediaId, { title: play.title, plays: 1 });
  }

  console.log(`Indexing Discogs masters against ${tracks.size.toLocaleString()} archive tracks`);
  const index = await buildIndex(dumpPath, new Set(tracks.keys()));

  let matchedTracks = 0;
  let matchedWithGenre = 0;
  let matchedPlays = 0;
  let totalPlays = 0;
  let matchedPlaysWithGenre = 0;
  let multiMaster = 0;
  let agreeingMasters = 0;
  const examples: Array<{ youtubeId: string; title: string; masterId: string; genres: string[]; styles: string[] }> = [];
  const perTrack: Array<{
    youtubeId: string;
    title: string;
    plays: number;
    masters: MasterGenres[];
    genreAgreement: boolean;
  }> = [];

  for (const [youtubeId, track] of tracks) {
    totalPlays += track.plays;
    const masters = index.get(youtubeId);
    if (!masters || masters.length === 0) continue;
    matchedTracks += 1;
    matchedPlays += track.plays;

    // Do the masters carrying this video agree on the top-level genre? When they
    // do not, the video is on both its own release and some compilation, and
    // picking one arbitrarily would mislabel the track.
    const genreSets = masters.map((master) => [...master.genres].sort().join('|'));
    const agreement = new Set(genreSets).size === 1;
    if (masters.length > 1) {
      multiMaster += 1;
      if (agreement) agreeingMasters += 1;
    }

    perTrack.push({ youtubeId, title: track.title, plays: track.plays, masters, genreAgreement: agreement });

    if (masters.some((master) => master.genres.length > 0)) {
      matchedWithGenre += 1;
      matchedPlaysWithGenre += track.plays;
      if (examples.length < 25) {
        const first = masters[0];
        examples.push({ youtubeId, title: track.title, masterId: first.masterId, genres: first.genres, styles: first.styles });
      }
    }
  }

  const percent = (value: number, total: number) => Number(((value / Math.max(total, 1)) * 100).toFixed(2));

  const summary = {
    generatedAt: new Date().toISOString(),
    dump: dumpPath,
    matchedVideoIds: index.size,
    distinctYoutubeTracks: tracks.size,
    totalYoutubePlays: totalPlays,
    matchedTracks: { count: matchedTracks, percent: percent(matchedTracks, tracks.size) },
    matchedTracksWithGenre: { count: matchedWithGenre, percent: percent(matchedWithGenre, tracks.size) },
    matchedPlays: { count: matchedPlays, percent: percent(matchedPlays, totalPlays) },
    matchedPlaysWithGenre: { count: matchedPlaysWithGenre, percent: percent(matchedPlaysWithGenre, totalPlays) },
    ambiguity: {
      tracksOnSeveralMasters: { count: multiMaster, percent: percent(multiMaster, matchedTracks) },
      thoseAgreeingOnGenre: { count: agreeingMasters, percent: percent(agreeingMasters, Math.max(multiMaster, 1)) },
    },
  };

  await writeFile(outputFile, JSON.stringify({ summary, examples, perTrack }, null, 2), 'utf8');
  console.log(`Wrote ${outputFile}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nExamples:');
  for (const example of examples.slice(0, 12)) {
    console.log(`  ${example.title.slice(0, 52)} -> ${example.genres.join(', ')} / ${example.styles.join(', ')}`);
  }
}

await main();
