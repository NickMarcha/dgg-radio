/**
 * PROTOTYPE: measure whether YouTube's public watch page exposes its visible
 * "Music" cards for a deterministic sample of historical DGG Radio videos.
 *
 * This is not production code. Responses and the result stay in the OS temp
 * directory. The parser deliberately targets YouTube's current private web
 * response and will break when that response changes.
 *
 *   npx tsx scripts/youtube-music-metadata-coverage.prototype.ts <queup-export.json> [sample-size]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const SAMPLE_SEED = 'dggradio-youtube-visible-music-v1';
const REQUEST_SPACING_MS = 1_000;
const cacheDirectory = join(tmpdir(), 'dggradio-youtube-music-coverage-cache');
const outputFile = join(tmpdir(), 'dggradio-youtube-music-coverage-sample.json');

interface QueupPlay {
  provider: string;
  providerMediaId: string;
  title: string;
}

interface QueupExport {
  exportedAt: string;
  plays: QueupPlay[];
}

interface HistoricalTrack {
  youtubeId: string;
  queupTitle: string;
  plays: number;
}

interface MusicTrack {
  title: string | null;
  artist: string | null;
  album: string | null;
  linkedYoutubeId: string | null;
  artworkUrl: string | null;
  credits: Record<string, string>;
}

interface ScrapeResult {
  youtubeId: string;
  queupTitle: string;
  plays: number;
  watchTitle: string | null;
  musicTracks: MusicTrack[];
  responseBytes: number;
  cache: 'hit' | 'miss';
  error: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractAssignedJson(html: string, marker: string): unknown {
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error(`${marker.trim()} was absent`);
  const start = html.indexOf('{', markerAt + marker.length);
  if (start < 0) throw new Error(`${marker.trim()} had no object`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error(`${marker.trim()} was not terminated`);
}

function extractInitialData(html: string): unknown {
  if (html.includes('var ytInitialData = ')) return extractAssignedJson(html, 'var ytInitialData = ');

  const scriptAt = html.indexOf('<script id="yt-initial-data"');
  if (scriptAt < 0) throw new Error('YouTube initial data was absent');
  const jsonStart = html.indexOf('>', scriptAt) + 1;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonStart === 0 || jsonEnd < 0) throw new Error('YouTube initial data script was malformed');
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function objectsNamed(value: unknown, key: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [candidateKey, child] of Object.entries(candidate)) {
      if (candidateKey === key && child && typeof child === 'object' && !Array.isArray(child)) {
        matches.push(child as Record<string, unknown>);
      }
      visit(child);
    }
  };
  visit(value);
  return matches;
}

function get(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function credits(view: Record<string, unknown>): Record<string, string> {
  const runs = get(view, [
    'overflowMenuOnTap',
    'innertubeCommand',
    'confirmDialogEndpoint',
    'content',
    'confirmDialogRenderer',
    'dialogMessages',
    0,
    'runs',
  ]);
  if (!Array.isArray(runs)) return {};
  const rendered = runs
    .map((run) =>
      run && typeof run === 'object' && typeof (run as Record<string, unknown>).text === 'string'
        ? ((run as Record<string, unknown>).text as string)
        : '',
    )
    .join('');
  return Object.fromEntries(
    rendered
      .split('\n\n')
      .map((line) => line.split(': ', 2))
      .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0]) && Boolean(pair[1])),
  );
}

function musicTracks(initialData: unknown): MusicTrack[] {
  const lists = objectsNamed(initialData, 'horizontalCardListRenderer').filter(
    (list) => get(list, ['header', 'richListHeaderRenderer', 'title', 'simpleText']) === 'Music',
  );
  return lists.flatMap((list) => {
    const cards = list.cards;
    if (!Array.isArray(cards)) return [];
    return cards.flatMap((card) => {
      const view = get(card, ['videoAttributeViewModel']);
      if (!view || typeof view !== 'object' || Array.isArray(view)) return [];
      const record = view as Record<string, unknown>;
      return [
        {
          title: text(record.title),
          artist: text(record.subtitle),
          album: text(get(record, ['secondarySubtitle', 'content'])),
          linkedYoutubeId: text(get(record, ['onTap', 'innertubeCommand', 'watchEndpoint', 'videoId'])),
          artworkUrl: text(get(record, ['image', 'sources', 0, 'url'])),
          credits: credits(record),
        },
      ];
    });
  });
}

function watchTitle(initialData: unknown): string | null {
  const primary = objectsNamed(initialData, 'videoPrimaryInfoRenderer')[0];
  return text(get(primary, ['title', 'runs', 0, 'text']));
}

let lastRequestAt = 0;

async function fetchWatchPage(track: HistoricalTrack): Promise<ScrapeResult> {
  const endpoint = new URL('https://www.youtube.com/watch');
  endpoint.searchParams.set('v', track.youtubeId);
  endpoint.searchParams.set('hl', 'en');
  endpoint.searchParams.set('gl', 'US');
  const cacheKey = sha256(
    `${endpoint.toString()}\nUser-Agent:${USER_AGENT}\nAccept-Language:${ACCEPT_LANGUAGE}`,
  );
  const cacheFile = join(cacheDirectory, `${cacheKey}.html`);
  let html: string;
  let cache: 'hit' | 'miss' = 'hit';
  try {
    html = await readFile(cacheFile, 'utf8');
  } catch {
    cache = 'miss';
    const remaining = REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    lastRequestAt = Date.now();
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': ACCEPT_LANGUAGE },
      signal: AbortSignal.timeout(20_000),
    });
    html = await response.text();
    if (!response.ok) throw new Error(`watch page answered ${response.status}`);
    await writeFile(cacheFile, html, 'utf8');
  }

  try {
    const initialData = extractInitialData(html);
    return {
      ...track,
      watchTitle: watchTitle(initialData),
      musicTracks: musicTracks(initialData),
      responseBytes: Buffer.byteLength(html),
      cache,
      error: null,
    };
  } catch (error) {
    return {
      ...track,
      watchTitle: null,
      musicTracks: [],
      responseBytes: Buffer.byteLength(html),
      cache,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function percentage(value: number): number {
  return Math.round(value * 10_000) / 100;
}

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  const sampleSize = Number(process.argv[3] ?? 100);
  if (!inputFile || !Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new Error('Pass a QueUp export path and an optional positive sample size.');
  }

  const exported = JSON.parse(await readFile(inputFile, 'utf8')) as QueupExport;
  const tracks = new Map<string, HistoricalTrack>();
  for (const play of exported.plays) {
    if (play.provider !== 'youtube' || !play.providerMediaId) continue;
    const prior = tracks.get(play.providerMediaId);
    if (prior) prior.plays += 1;
    else tracks.set(play.providerMediaId, { youtubeId: play.providerMediaId, queupTitle: play.title, plays: 1 });
  }
  const sample = [...tracks.values()]
    .sort((left, right) =>
      sha256(`${SAMPLE_SEED}:${left.youtubeId}`).localeCompare(sha256(`${SAMPLE_SEED}:${right.youtubeId}`)),
    )
    .slice(0, Math.min(sampleSize, tracks.size));

  await mkdir(cacheDirectory, { recursive: true });
  const results: ScrapeResult[] = [];
  for (let index = 0; index < sample.length; index += 1) {
    results.push(await fetchWatchPage(sample[index]!));
    if ((index + 1) % 10 === 0 || index + 1 === sample.length) {
      const matched = results.filter((result) => result.musicTracks.length > 0).length;
      console.log(`${index + 1}/${sample.length}: ${matched} pages with visible Music metadata`);
    }
  }

  const matched = results.filter((result) => result.musicTracks.length > 0);
  const errored = results.filter((result) => result.error);
  const cards = matched.flatMap((result) => result.musicTracks);
  const result = {
    generatedAt: new Date().toISOString(),
    sourceExportedAt: exported.exportedAt,
    methodology: {
      sampleSeed: SAMPLE_SEED,
      sampleSize: sample.length,
      endpoint: 'public youtube.com/watch HTML, ytInitialData assignment or script element',
      requestSpacingMs: REQUEST_SPACING_MS,
      cookies: false,
      authentication: false,
      youtubeDataApiCalls: 0,
      networkRequests: results.filter((item) => item.cache === 'miss').length,
      cachedResponses: results.filter((item) => item.cache === 'hit').length,
    },
    coverage: {
      pagesWithMusic: matched.length,
      pagesWithMusicPercent: percentage(matched.length / results.length),
      totalMusicCards: cards.length,
      pagesWithMultipleMusicCards: matched.filter((item) => item.musicTracks.length > 1).length,
      cardsWithTitle: cards.filter((card) => card.title).length,
      cardsWithArtist: cards.filter((card) => card.artist).length,
      cardsWithAlbum: cards.filter((card) => card.album).length,
      cardsWithLinkedYoutubeId: cards.filter((card) => card.linkedYoutubeId).length,
      cardsWithCredits: cards.filter((card) => Object.keys(card.credits).length > 0).length,
      pagesWithErrors: errored.length,
    },
    matchedExamples: matched.slice(0, 20),
    unmatchedExamples: results.filter((result) => !result.error && result.musicTracks.length === 0).slice(0, 20),
    errors: errored,
    results,
  };
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputFile}`);
}

await main();
