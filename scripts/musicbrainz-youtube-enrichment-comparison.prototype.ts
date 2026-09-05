/**
 * PROTOTYPE: compare MusicBrainz recording searches made from an arbitrary
 * YouTube upload title with searches made from YouTube's visible Music cards.
 *
 * MusicBrainz permits one request per second per source IP. This script starts
 * requests at least 1.1 seconds apart, sends a meaningful User-Agent, and
 * caches every response in the OS temporary directory by complete URL and
 * request headers.
 *
 *   npx tsx scripts/musicbrainz-youtube-enrichment-comparison.prototype.ts \
 *     <youtube-coverage-result.json>
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
const REQUEST_SPACING_MS = 1_500;
const SEARCH_LIMIT = 10;
const cacheDirectory = join(tmpdir(), 'dggradio-musicbrainz-youtube-enriched-cache');
const outputFile = join(tmpdir(), 'dggradio-musicbrainz-youtube-enrichment-comparison.json');

interface YoutubeMusicTrack {
  title: string | null;
  artist: string | null;
  album: string | null;
  linkedYoutubeId: string | null;
}

interface YoutubeCoverageItem {
  youtubeId: string;
  watchTitle: string | null;
  musicTracks: YoutubeMusicTrack[];
}

interface YoutubeCoverageResult {
  generatedAt: string;
  results: YoutubeCoverageItem[];
}

interface MusicBrainzArtistCredit {
  name?: string;
  joinphrase?: string;
  artist?: { id?: string; name?: string };
}

interface MusicBrainzRelease {
  id?: string;
  title?: string;
}

interface MusicBrainzRecording {
  id: string;
  score?: number;
  title?: string;
  length?: number;
  video?: boolean;
  disambiguation?: string;
  'artist-credit'?: MusicBrainzArtistCredit[];
  releases?: MusicBrainzRelease[];
  genres?: Array<{ name?: string; count?: number }>;
  tags?: Array<{ name?: string; count?: number }>;
}

interface MusicBrainzSearchResponse {
  count?: number;
  recordings?: MusicBrainzRecording[];
}

interface MusicBrainzUrlResponse {
  urls?: Array<{
    resource?: string;
    relations?: Array<{ recording?: MusicBrainzRecording }>;
  }>;
  resource?: string;
  relations?: Array<{ recording?: MusicBrainzRecording }>;
}

type Strategy = 'rawUploadTitle' | 'cleanTitleArtist' | 'songTitleArtist' | 'cleanTitleArtistAlbum';

interface Card {
  key: string;
  sourceYoutubeId: string;
  linkedYoutubeId: string | null;
  watchTitle: string;
  title: string;
  artist: string | null;
  album: string | null;
}

interface CandidateAssessment {
  mbid: string;
  score: number;
  title: string | null;
  artistCredit: string | null;
  genres: Array<{ name: string; count: number }>;
  tags: Array<{ name: string; count: number }>;
  releaseIds: string[];
  releaseTitles: string[];
  titleMatches: boolean;
  songTitleMatches: boolean;
  artistMatches: boolean;
  albumMatches: boolean | null;
  metadataMatches: boolean;
  songMetadataMatches: boolean;
  exactUrlReferenceMatches: boolean | null;
}

interface StrategyResult {
  query: string | null;
  candidates: CandidateAssessment[];
  error: string | null;
}

interface CardResult extends Card {
  exactUrlReferenceMbids: string[];
  exactUrlReferences: {
    sourceVideoMbids: string[];
    linkedVideoMbids: string[];
  };
  strategies: Record<Strategy, StrategyResult>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function percentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 100;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\bn\b/g, 'and')
    .replace(/\s+/g, ' ');
}

function songTitle(value: string): string {
  const removableQualifiers = [
    /\s*[\[(](?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?[\])]/giu,
    /\s*[\[(](?:official(?:\s+music)?\s+video|official\s+audio|official\s+visuali[sz]er|lyric\s+video|visuali[sz]er|hd\s+upscale)[\])]/giu,
    /\s*[\[(](?:feat(?:uring)?\.?|ft\.?)\s+[^\])]+[\])]/giu,
    /\s*[\[(]no\s+[^\])]+\s+version[\])]/giu,
    /\s*[\[(]from\s+[^\])]*soundtrack[\])]/giu,
    /\s*[\[(]\d{4}[\])]/gu,
  ];
  return removableQualifiers.reduce((title, pattern) => title.replace(pattern, ''), value).trim();
}

function tokens(value: string | null | undefined): Set<string> {
  const ignored = new Set(['and', 'the', 'feat', 'featuring', 'ft', 'with', 'x']);
  return new Set(normalize(value).split(' ').filter((token) => token && !ignored.has(token)));
}

function tokenSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function artistCredit(recording: MusicBrainzRecording): string | null {
  const credit = recording['artist-credit']
    ?.map((part) => `${part.name ?? part.artist?.name ?? ''}${part.joinphrase ?? ''}`)
    .join('')
    .trim();
  return credit || null;
}

function artistMatches(expected: string | null, recording: MusicBrainzRecording): boolean {
  if (!expected) return false;
  const combined = artistCredit(recording);
  if (normalize(expected) === normalize(combined)) return true;
  const individualNames = recording['artist-credit']
    ?.map((part) => part.name ?? part.artist?.name)
    .filter((name): name is string => Boolean(name)) ?? [];
  if (individualNames.some((name) => normalize(name) === normalize(expected))) return true;
  return tokenSimilarity(expected, combined) >= 0.8;
}

function lucenePhrase(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function queryFor(card: Card, strategy: Strategy): { query: string; dismax: boolean } | null {
  if (strategy === 'rawUploadTitle') return { query: card.watchTitle, dismax: true };
  if (!card.artist) return null;
  if (strategy === 'songTitleArtist') {
    return {
      query: `recording:${lucenePhrase(songTitle(card.title))} AND artist:${lucenePhrase(card.artist)}`,
      dismax: false,
    };
  }
  const titleAndArtist = `recording:${lucenePhrase(card.title)} AND artist:${lucenePhrase(card.artist)}`;
  if (strategy === 'cleanTitleArtist') return { query: titleAndArtist, dismax: false };
  if (!card.album) return null;
  return { query: `${titleAndArtist} AND release:${lucenePhrase(card.album)}`, dismax: false };
}

function youtubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

function youtubeId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] ?? null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

let lastRequestStartedAt = 0;
let networkRequests = 0;
let cachedRequests = 0;

async function waitForRequestSlot(): Promise<void> {
  const remaining = REQUEST_SPACING_MS - (Date.now() - lastRequestStartedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastRequestStartedAt = Date.now();
}

async function cachedJson<T>(endpoint: URL): Promise<T> {
  const cacheKey = sha256(`${endpoint.toString()}\nAccept:application/json\nUser-Agent:${USER_AGENT}`);
  const cacheFile = join(cacheDirectory, `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as T;
    cachedRequests += 1;
    return cached;
  } catch {
    // Fetch and cache missing or unreadable entries below.
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await waitForRequestSlot();
    networkRequests += 1;
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const raw = await response.text();
        await writeFile(cacheFile, raw, 'utf8');
        return JSON.parse(raw) as T;
      }
      if (![429, 503].includes(response.status) || attempt === 5) {
        throw new Error(`MusicBrainz answered ${response.status}: ${endpoint.toString()}`);
      }
      const retryAfter = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfter === null ? null : Number(retryAfter);
      const delay = retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)
        ? Math.max(retryAfterSeconds * 1_000, 2_000)
        : 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      if (attempt === 5 || (error instanceof Error && error.message.startsWith('MusicBrainz answered'))) {
        throw error;
      }
      const delay = 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`MusicBrainz request exhausted retries: ${endpoint.toString()}`);
}

async function exactUrlReferences(cards: Card[]): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(cards.flatMap((card) => [card.sourceYoutubeId, card.linkedYoutubeId].filter(Boolean) as string[]))];
  const references = new Map<string, Set<string>>();
  for (const [index, batch] of chunks(ids, 100).entries()) {
    const endpoint = new URL('https://musicbrainz.org/ws/2/url');
    for (const id of batch) endpoint.searchParams.append('resource', youtubeUrl(id));
    endpoint.searchParams.set('inc', 'recording-rels');
    endpoint.searchParams.set('fmt', 'json');
    console.log(`Exact URL reference batch ${index + 1}/${Math.ceil(ids.length / 100)}`);
    const response = await cachedJson<MusicBrainzUrlResponse>(endpoint);
    const urls = response.urls ?? (response.resource ? [response] : []);
    for (const url of urls) {
      const id = youtubeId(url.resource);
      if (!id) continue;
      const mbids = new Set(
        url.relations?.flatMap((relation) => (relation.recording?.id ? [relation.recording.id] : [])) ?? [],
      );
      if (mbids.size > 0) references.set(id, mbids);
    }
  }
  return references;
}

async function search(query: string, dismax: boolean): Promise<MusicBrainzRecording[]> {
  const endpoint = new URL('https://musicbrainz.org/ws/2/recording');
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('limit', String(SEARCH_LIMIT));
  endpoint.searchParams.set('fmt', 'json');
  if (dismax) endpoint.searchParams.set('dismax', 'true');
  const response = await cachedJson<MusicBrainzSearchResponse>(endpoint);
  return response.recordings ?? [];
}

function assess(card: Card, recording: MusicBrainzRecording, references: Set<string>): CandidateAssessment {
  const releaseTitles = recording.releases?.flatMap((release) => (release.title ? [release.title] : [])) ?? [];
  const releaseIds = recording.releases?.flatMap((release) => (release.id ? [release.id] : [])) ?? [];
  const titleMatches = normalize(card.title) === normalize(recording.title);
  const songTitleMatches = normalize(songTitle(card.title)) === normalize(songTitle(recording.title ?? ''));
  const artistMatch = artistMatches(card.artist, recording);
  return {
    mbid: recording.id,
    score: Number(recording.score ?? 0),
    title: recording.title ?? null,
    artistCredit: artistCredit(recording),
    genres:
      recording.genres?.flatMap((genre) =>
        genre.name ? [{ name: genre.name, count: Number(genre.count ?? 0) }] : [],
      ) ?? [],
    tags:
      recording.tags?.flatMap((tag) =>
        tag.name ? [{ name: tag.name, count: Number(tag.count ?? 0) }] : [],
      ) ?? [],
    releaseIds,
    releaseTitles,
    titleMatches,
    songTitleMatches,
    artistMatches: artistMatch,
    albumMatches: card.album ? releaseTitles.some((release) => normalize(release) === normalize(card.album)) : null,
    metadataMatches: titleMatches && artistMatch,
    songMetadataMatches: songTitleMatches && artistMatch,
    exactUrlReferenceMatches: references.size > 0 ? references.has(recording.id) : null,
  };
}

function strategySummary(results: CardResult[], strategy: Strategy) {
  const attempted = results.filter((result) => result.strategies[strategy].query);
  const completed = attempted.filter((result) => !result.strategies[strategy].error);
  const withCandidates = completed.filter((result) => result.strategies[strategy].candidates.length > 0);
  const topMetadataMatches = completed.filter((result) => result.strategies[strategy].candidates[0]?.metadataMatches);
  const metadataInTop10 = completed.filter((result) =>
    result.strategies[strategy].candidates.some((candidate) => candidate.metadataMatches),
  );
  const topSongMetadataMatches = completed.filter(
    (result) => result.strategies[strategy].candidates[0]?.songMetadataMatches,
  );
  const songMetadataInTop10 = completed.filter((result) =>
    result.strategies[strategy].candidates.some((candidate) => candidate.songMetadataMatches),
  );
  const uniqueMetadataInTop10 = completed.filter(
    (result) => result.strategies[strategy].candidates.filter((candidate) => candidate.metadataMatches).length === 1,
  );
  const topAlbumMatches = completed.filter((result) => result.strategies[strategy].candidates[0]?.albumMatches === true);
  const referenceCards = completed.filter((result) => result.exactUrlReferenceMbids.length > 0);
  const topReferenceMatches = referenceCards.filter(
    (result) => result.strategies[strategy].candidates[0]?.exactUrlReferenceMatches === true,
  );
  const referenceInTop10 = referenceCards.filter((result) =>
    result.strategies[strategy].candidates.some((candidate) => candidate.exactUrlReferenceMatches === true),
  );
  return {
    attempted: attempted.length,
    completed: completed.length,
    errors: attempted.length - completed.length,
    withCandidates: withCandidates.length,
    topMetadataMatches: topMetadataMatches.length,
    topMetadataMatchesPercent: percentage(topMetadataMatches.length / completed.length),
    metadataMatchInTop10: metadataInTop10.length,
    metadataMatchInTop10Percent: percentage(metadataInTop10.length / completed.length),
    topSongMetadataMatches: topSongMetadataMatches.length,
    topSongMetadataMatchesPercent: percentage(topSongMetadataMatches.length / completed.length),
    songMetadataMatchInTop10: songMetadataInTop10.length,
    songMetadataMatchInTop10Percent: percentage(songMetadataInTop10.length / completed.length),
    exactlyOneMetadataMatchInTop10: uniqueMetadataInTop10.length,
    topAlbumMatches: topAlbumMatches.length,
    exactUrlReferenceCards: referenceCards.length,
    topExactUrlReferenceMatches: topReferenceMatches.length,
    topExactUrlReferenceMatchesPercent: percentage(topReferenceMatches.length / referenceCards.length),
    exactUrlReferenceMatchInTop10: referenceInTop10.length,
    exactUrlReferenceMatchInTop10Percent: percentage(referenceInTop10.length / referenceCards.length),
  };
}

function pairedSummary(
  results: CardResult[],
  left: Strategy,
  right: Strategy,
  matchField: 'metadataMatches' | 'songMetadataMatches' = 'metadataMatches',
) {
  const comparable = results.filter(
    (result) => result.strategies[left].query && result.strategies[right].query
      && !result.strategies[left].error && !result.strategies[right].error,
  );
  const metadataImproved = comparable.filter(
    (result) => !result.strategies[left].candidates[0]?.[matchField]
      && result.strategies[right].candidates[0]?.[matchField],
  );
  const metadataRegressed = comparable.filter(
    (result) => result.strategies[left].candidates[0]?.[matchField]
      && !result.strategies[right].candidates[0]?.[matchField],
  );
  const referenceComparable = comparable.filter((result) => result.exactUrlReferenceMbids.length > 0);
  const referenceImproved = referenceComparable.filter(
    (result) => !result.strategies[left].candidates[0]?.exactUrlReferenceMatches
      && result.strategies[right].candidates[0]?.exactUrlReferenceMatches,
  );
  const referenceRegressed = referenceComparable.filter(
    (result) => result.strategies[left].candidates[0]?.exactUrlReferenceMatches
      && !result.strategies[right].candidates[0]?.exactUrlReferenceMatches,
  );
  return {
    comparableCards: comparable.length,
    topMetadataImproved: metadataImproved.length,
    topMetadataRegressed: metadataRegressed.length,
    exactUrlReferenceComparableCards: referenceComparable.length,
    topExactUrlReferenceImproved: referenceImproved.length,
    topExactUrlReferenceRegressed: referenceRegressed.length,
    improvedExamples: metadataImproved.slice(0, 15).map((result) => result.key),
    regressedExamples: metadataRegressed.slice(0, 15).map((result) => result.key),
  };
}

async function main(): Promise<void> {
  const inputFile = process.argv[2] ?? join(tmpdir(), 'dggradio-youtube-music-coverage-sample.json');
  const youtube = JSON.parse(await readFile(inputFile, 'utf8')) as YoutubeCoverageResult;
  const cards: Card[] = youtube.results.flatMap((item) =>
    item.musicTracks.flatMap((track, index) =>
      track.title && item.watchTitle
        ? [{
            key: `${item.youtubeId}:${index}`,
            sourceYoutubeId: item.youtubeId,
            linkedYoutubeId: track.linkedYoutubeId,
            watchTitle: item.watchTitle,
            title: track.title,
            artist: track.artist,
            album: track.album,
          }]
        : [],
    ),
  );
  await mkdir(cacheDirectory, { recursive: true });
  console.log(`Comparing ${cards.length} YouTube Music cards`);
  const exactReferences = await exactUrlReferences(cards);
  const results: CardResult[] = [];
  const strategies: Strategy[] = [
    'rawUploadTitle',
    'cleanTitleArtist',
    'songTitleArtist',
    'cleanTitleArtistAlbum',
  ];

  for (const [cardIndex, card] of cards.entries()) {
    const sourceVideoMbids = [...(exactReferences.get(card.sourceYoutubeId) ?? [])];
    const linkedVideoMbids = card.linkedYoutubeId ? [...(exactReferences.get(card.linkedYoutubeId) ?? [])] : [];
    const references = new Set([...sourceVideoMbids, ...linkedVideoMbids]);
    const strategyResults = {} as Record<Strategy, StrategyResult>;
    for (const strategy of strategies) {
      const request = queryFor(card, strategy);
      if (!request) {
        strategyResults[strategy] = { query: null, candidates: [], error: null };
        continue;
      }
      try {
        const recordings = await search(request.query, request.dismax);
        strategyResults[strategy] = {
          query: request.query,
          candidates: recordings.map((recording) => assess(card, recording, references)),
          error: null,
        };
      } catch (error) {
        strategyResults[strategy] = {
          query: request.query,
          candidates: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    results.push({
      ...card,
      exactUrlReferenceMbids: [...references],
      exactUrlReferences: { sourceVideoMbids, linkedVideoMbids },
      strategies: strategyResults,
    });
    if ((cardIndex + 1) % 10 === 0 || cardIndex + 1 === cards.length) {
      console.log(`${cardIndex + 1}/${cards.length} cards compared`);
    }
  }

  const sourceCardCounts = new Map<string, number>();
  for (const card of results) {
    sourceCardCounts.set(card.sourceYoutubeId, (sourceCardCounts.get(card.sourceYoutubeId) ?? 0) + 1);
  }
  const singleCardResults = results.filter((card) => sourceCardCounts.get(card.sourceYoutubeId) === 1);
  const multiCardResults = results.filter((card) => (sourceCardCounts.get(card.sourceYoutubeId) ?? 0) > 1);
  const summarizeStrategies = (items: CardResult[]) =>
    Object.fromEntries(strategies.map((strategy) => [strategy, strategySummary(items, strategy)]));

  const result = {
    generatedAt: new Date().toISOString(),
    sourceYoutubeCoverageGeneratedAt: youtube.generatedAt,
    methodology: {
      cards: cards.length,
      searchLimit: SEARCH_LIMIT,
      requestSpacingMs: REQUEST_SPACING_MS,
      networkRequests,
      cachedRequests,
      rawUploadTitle: 'unfielded recording search with dismax=true',
      cleanTitleArtist: 'exact-phrase recording and artist fields',
      cleanTitleArtistAlbum: 'exact-phrase recording, artist, and release fields',
      metadataMatch:
        'normalized title equality and compatible artist credit; this checks catalog facts, not exact recording identity',
      exactUrlReference:
        'recording MBID related by MusicBrainz to either the source video or YouTube-linked recording video',
    },
    strategies: summarizeStrategies(results),
    cohorts: {
      singleCardVideos: {
        cards: singleCardResults.length,
        strategies: summarizeStrategies(singleCardResults),
        rawToCleanTitleArtist: pairedSummary(singleCardResults, 'rawUploadTitle', 'cleanTitleArtist'),
        rawToSongTitleArtist: pairedSummary(
          singleCardResults,
          'rawUploadTitle',
          'songTitleArtist',
          'songMetadataMatches',
        ),
      },
      multiCardVideos: {
        cards: multiCardResults.length,
        sourceVideos: new Set(multiCardResults.map((card) => card.sourceYoutubeId)).size,
        strategies: summarizeStrategies(multiCardResults),
        rawToCleanTitleArtist: pairedSummary(multiCardResults, 'rawUploadTitle', 'cleanTitleArtist'),
        rawToSongTitleArtist: pairedSummary(
          multiCardResults,
          'rawUploadTitle',
          'songTitleArtist',
          'songMetadataMatches',
        ),
      },
    },
    comparisons: {
      rawToCleanTitleArtist: pairedSummary(results, 'rawUploadTitle', 'cleanTitleArtist'),
      rawToSongTitleArtist: pairedSummary(
        results,
        'rawUploadTitle',
        'songTitleArtist',
        'songMetadataMatches',
      ),
      cleanTitleArtistToAlbum: pairedSummary(results, 'cleanTitleArtist', 'cleanTitleArtistAlbum'),
    },
    results,
  };
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputFile}`);
  console.log(JSON.stringify({ strategies: result.strategies, comparisons: result.comparisons }, null, 2));
}

await main();
