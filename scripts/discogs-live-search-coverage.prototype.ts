/**
 * PROTOTYPE: measure the live Discogs search path for a track that is playing
 * now and is not in the monthly dump.
 *
 * The dump is joined on a YouTube video id, which the Discogs API cannot query.
 * So a live lookup has to search by the artist and track name taken from the
 * YouTube Music card, which is fuzzy in a way the dump join never is. This
 * measures how often that search returns something, and how often the thing it
 * returns is actually by the right artist.
 *
 * Discogs allows 25 unauthenticated requests a minute. This script spaces them
 * at 2.5 seconds and caches every response in the OS temporary directory.
 *
 *   npx tsx scripts/discogs-live-search-coverage.prototype.ts
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
const REQUEST_SPACING_MS = 2_500;
const cacheDirectory = join(tmpdir(), 'dggradio-discogs-live-search-cache');
const outputFile = join(tmpdir(), 'dggradio-discogs-live-search-coverage.json');

interface SearchResult {
  type?: string;
  id?: number;
  title?: string;
  genre?: string[];
  style?: string[];
  year?: string;
}

interface SearchResponse {
  pagination?: { items?: number };
  results?: SearchResult[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(\d+\)\s*$/, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

let lastRequestStartedAt = 0;
let networkRequests = 0;
let cachedRequests = 0;

async function cachedJson<T>(endpoint: URL): Promise<T> {
  const cacheFile = join(cacheDirectory, `${sha256(`${endpoint}\nUser-Agent:${USER_AGENT}`)}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as T;
    cachedRequests += 1;
    return cached;
  } catch {
    // Fall through and fetch.
  }

  const remaining = REQUEST_SPACING_MS - (Date.now() - lastRequestStartedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastRequestStartedAt = Date.now();
  networkRequests += 1;

  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Discogs answered ${response.status}`);
  const raw = await response.text();
  await writeFile(cacheFile, raw, 'utf8');
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const temp = tmpdir();
  const sample = JSON.parse(
    await readFile(join(temp, 'dggradio-youtube-music-coverage-sample.json'), 'utf8'),
  ) as { results: Array<{ youtubeId: string; musicTracks?: Array<{ title?: string; artist?: string }> }> };
  const dump = JSON.parse(
    await readFile(join(temp, 'dggradio-discogs-dump-coverage.json'), 'utf8'),
  ) as { perTrack: Array<{ youtubeId: string }> };

  await mkdir(cacheDirectory, { recursive: true });
  const inDump = new Set(dump.perTrack.map((track) => track.youtubeId));

  // The live path only matters where the dump missed and a Music card gave us
  // clean fields to search with.
  const candidates = sample.results.flatMap((video) => {
    const card = video.musicTracks?.[0];
    if (inDump.has(video.youtubeId) || !card?.title || !card.artist) return [];
    return [{ youtubeId: video.youtubeId, title: card.title, artist: card.artist }];
  });

  console.log(`Searching Discogs for ${candidates.length} tracks the dump missed`);

  const rows = [];
  for (const [index, candidate] of candidates.entries()) {
    if ((index + 1) % 10 === 0) console.log(`${index + 1}/${candidates.length}`);

    const endpoint = new URL('https://api.discogs.com/database/search');
    endpoint.searchParams.set('artist', candidate.artist);
    endpoint.searchParams.set('track', candidate.title);
    endpoint.searchParams.set('type', 'master');
    endpoint.searchParams.set('per_page', '5');

    let response: SearchResponse;
    try {
      response = await cachedJson<SearchResponse>(endpoint);
    } catch (error) {
      rows.push({
        ...candidate,
        error: String(error),
        results: 0,
        topTitle: null as string | null,
        artistMatches: false,
        genres: [] as string[],
        styles: [] as string[],
      });
      continue;
    }

    const results = response.results ?? [];
    const top = results[0];
    // Search titles read "Artist - Release", so the credited artist is the part
    // before the first dash. This is the only precision check available without
    // a second request per result.
    const topArtist = top?.title?.split(' - ')[0] ?? '';
    const artistMatches =
      normalize(topArtist).length > 0 &&
      (normalize(topArtist).includes(normalize(candidate.artist)) ||
        normalize(candidate.artist).includes(normalize(topArtist)));

    rows.push({
      ...candidate,
      error: null,
      results: results.length,
      topTitle: top?.title ?? null,
      artistMatches,
      genres: top?.genre ?? [],
      styles: top?.style ?? [],
    });
  }

  const answered = rows.filter((row) => row.results > 0);
  const correct = rows.filter((row) => row.artistMatches && row.genres.length > 0);
  const wrongArtist = answered.filter((row) => !row.artistMatches);
  const percent = (value: number) => Number(((value / Math.max(rows.length, 1)) * 100).toFixed(1));

  const summary = {
    generatedAt: new Date().toISOString(),
    candidates: rows.length,
    returnedAnything: { count: answered.length, percent: percent(answered.length) },
    topResultArtistMatches: { count: correct.length, percent: percent(correct.length) },
    topResultWrongArtist: { count: wrongArtist.length, percent: percent(wrongArtist.length) },
    requests: { networkRequests, cachedRequests },
  };

  await writeFile(outputFile, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nWrong-artist examples:');
  for (const row of wrongArtist.slice(0, 8)) {
    console.log(`  card: ${row.artist} - ${row.title}\n    got: ${row.topTitle} [${row.genres.join(', ')}]`);
  }
  console.log('\nCorrect examples:');
  for (const row of correct.slice(0, 6)) {
    console.log(`  ${row.artist} - ${row.title} -> ${row.genres.join(', ')} / ${row.styles.join(', ')}`);
  }
}

await main();
