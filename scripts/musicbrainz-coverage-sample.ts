/**
 * Measures exact MusicBrainz URL coverage for a deterministic sample of a
 * QueUp room export. This is an analysis tool, not the enrichment worker.
 *
 * MusicBrainz allows one request per second per source IP. Requests start at
 * least 1.1 seconds apart, exact URL lookups are batched in hundreds, and raw
 * responses are cached in the OS temp directory by the complete request URL
 * and User-Agent.
 *
 *   npx tsx scripts/musicbrainz-coverage-sample.ts <queup-export.json> [sample-size]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
const REQUEST_SPACING_MS = 1_100;
const BATCH_SIZE = 100;
const SAMPLE_SEED = 'dggradio-musicbrainz-exact-url-v1';
const cacheDirectory = join(tmpdir(), 'dggradio-musicbrainz-coverage-cache');
const outputFile = join(tmpdir(), 'dggradio-musicbrainz-coverage-sample.json');

interface QueupPlay {
  id: string;
  provider: string;
  providerMediaId: string;
  title: string;
  durationSeconds: number;
  playedAt: string;
}

interface QueupExport {
  exportedAt: string;
  room: { name: string; slug: string };
  plays: QueupPlay[];
}

interface Track {
  providerMediaId: string;
  title: string;
  durationSeconds: number;
  plays: number;
  newestPlayAt: string;
  oldestPlayAt: string;
}

interface MusicBrainzRecording {
  id: string;
  title?: string;
  disambiguation?: string;
  video?: boolean;
  'artist-credit'?: Array<{
    name?: string;
    artist?: { id?: string; name?: string; 'sort-name'?: string };
  }>;
}

interface MusicBrainzUrl {
  id?: string;
  resource?: string;
  relations?: Array<{
    type?: string;
    attributes?: string[];
    recording?: MusicBrainzRecording;
  }>;
}

interface MusicBrainzUrlResponse {
  urls?: MusicBrainzUrl[];
  id?: string;
  resource?: string;
  relations?: MusicBrainzUrl['relations'];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

function wilson95(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: centre - spread, high: centre + spread };
}

function percentage(value: number): number {
  return Math.round(value * 10_000) / 100;
}

function artistCredit(recording: MusicBrainzRecording): string | null {
  const names = recording['artist-credit']
    ?.map((credit) => credit.name ?? credit.artist?.name)
    .filter((name): name is string => Boolean(name));
  return names && names.length > 0 ? names.join(' + ') : null;
}

let lastRequestStartedAt = 0;
let networkRequests = 0;
let cachedRequests = 0;

async function waitForRequestSlot(): Promise<void> {
  const remaining = REQUEST_SPACING_MS - (Date.now() - lastRequestStartedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  lastRequestStartedAt = Date.now();
}

async function lookupBatch(ids: string[]): Promise<MusicBrainzUrl[]> {
  const endpoint = new URL('https://musicbrainz.org/ws/2/url');
  for (const id of ids) endpoint.searchParams.append('resource', youtubeUrl(id));
  endpoint.searchParams.set('inc', 'recording-rels');
  endpoint.searchParams.set('fmt', 'json');

  const cacheKey = sha256(`${endpoint.toString()}\nUser-Agent:${USER_AGENT}`);
  const cacheFile = join(cacheDirectory, `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as MusicBrainzUrlResponse;
    cachedRequests += 1;
    return cached.urls ?? (cached.resource ? [cached] : []);
  } catch {
    // A missing or unreadable cache entry is fetched and replaced below.
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForRequestSlot();
    networkRequests += 1;
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const raw = await response.text();
      await writeFile(cacheFile, raw, 'utf8');
      const parsed = JSON.parse(raw) as MusicBrainzUrlResponse;
      return parsed.urls ?? (parsed.resource ? [parsed] : []);
    }
    if (response.status !== 503 || attempt === 3) {
      throw new Error(`MusicBrainz answered ${response.status} for a ${ids.length}-URL batch.`);
    }
    const delay = 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return [];
}

async function main(): Promise<void> {
  const inputFile = process.argv[2];
  const requestedSampleSize = Number(process.argv[3] ?? 1_000);
  if (!inputFile || !Number.isInteger(requestedSampleSize) || requestedSampleSize < 1) {
    console.error('Usage: npx tsx scripts/musicbrainz-coverage-sample.ts <queup-export.json> [sample-size]');
    process.exit(1);
  }

  const exported = JSON.parse(await readFile(inputFile, 'utf8')) as QueupExport;
  const youtubeTracks = new Map<string, Track>();
  const soundcloudTracks = new Map<string, Track>();

  for (const play of exported.plays) {
    if (!play.providerMediaId) continue;
    const target = play.provider === 'youtube' ? youtubeTracks : play.provider === 'soundcloud' ? soundcloudTracks : null;
    if (!target) continue;
    const existing = target.get(play.providerMediaId);
    if (existing) {
      existing.plays += 1;
      if (play.playedAt > existing.newestPlayAt) existing.newestPlayAt = play.playedAt;
      if (play.playedAt < existing.oldestPlayAt) existing.oldestPlayAt = play.playedAt;
    } else {
      target.set(play.providerMediaId, {
        providerMediaId: play.providerMediaId,
        title: play.title,
        durationSeconds: play.durationSeconds,
        plays: 1,
        newestPlayAt: play.playedAt,
        oldestPlayAt: play.playedAt,
      });
    }
  }

  const sample = [...youtubeTracks.values()]
    .sort((left, right) =>
      sha256(`${SAMPLE_SEED}:${left.providerMediaId}`).localeCompare(
        sha256(`${SAMPLE_SEED}:${right.providerMediaId}`),
      ),
    )
    .slice(0, Math.min(requestedSampleSize, youtubeTracks.size));

  await mkdir(cacheDirectory, { recursive: true });
  const foundUrls = new Map<string, MusicBrainzUrl>();
  const batches = chunks(sample, BATCH_SIZE);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    console.log(`MusicBrainz batch ${index + 1}/${batches.length}, ${batch.length} URLs`);
    const answers = await lookupBatch(batch.map((track) => track.providerMediaId));
    for (const answer of answers) {
      const id = youtubeId(answer.resource);
      if (id) foundUrls.set(id, answer);
    }
  }

  const matched = sample.flatMap((track) => {
    const url = foundUrls.get(track.providerMediaId);
    const recordings =
      url?.relations?.flatMap((relation) => (relation.recording ? [relation.recording] : [])) ?? [];
    return recordings.length > 0 ? [{ track, url, recordings }] : [];
  });
  const knownWithoutRecording = sample.filter((track) => {
    const answer = foundUrls.get(track.providerMediaId);
    return answer && !answer.relations?.some((relation) => relation.recording);
  });
  const unmatched = sample.filter(
    (track) => !matched.some((answer) => answer.track.providerMediaId === track.providerMediaId),
  );

  const sampledPlays = sample.reduce((sum, track) => sum + track.plays, 0);
  const matchedPlays = matched.reduce((sum, answer) => sum + answer.track.plays, 0);
  const confidence = wilson95(matched.length, sample.length);
  const populationYouTubePlays = [...youtubeTracks.values()].reduce((sum, track) => sum + track.plays, 0);
  const populationSoundcloudPlays = [...soundcloudTracks.values()].reduce((sum, track) => sum + track.plays, 0);

  const result = {
    generatedAt: new Date().toISOString(),
    source: {
      room: exported.room,
      exportedAt: exported.exportedAt,
      totalPlays: exported.plays.length,
      youtubePlays: populationYouTubePlays,
      youtubeDistinctTracks: youtubeTracks.size,
      soundcloudPlays: populationSoundcloudPlays,
      soundcloudDistinctTracks: soundcloudTracks.size,
    },
    methodology: {
      sampleSeed: SAMPLE_SEED,
      sampleUnit: 'distinct YouTube providerMediaId',
      sampleSize: sample.length,
      lookup: 'exact canonical YouTube URL with inc=recording-rels',
      musicBrainzBatchSize: BATCH_SIZE,
      requestSpacingMs: REQUEST_SPACING_MS,
      networkRequests,
      cachedRequests,
      soundcloudExcluded:
        'QueUp stores numeric SoundCloud track IDs, not the permalinks required for exact MusicBrainz URL lookup.',
    },
    coverage: {
      exactUrlKnown: foundUrls.size,
      exactUrlKnownPercent: percentage(foundUrls.size / sample.length),
      recordingMatched: matched.length,
      recordingMatchedPercent: percentage(matched.length / sample.length),
      recordingMatchedWilson95LowPercent: percentage(confidence.low),
      recordingMatchedWilson95HighPercent: percentage(confidence.high),
      knownWithoutRecordingRelation: knownWithoutRecording.length,
      sampledHistoricalPlays: sampledPlays,
      matchedHistoricalPlays: matchedPlays,
      playWeightedCoveragePercent: percentage(matchedPlays / sampledPlays),
    },
    matchedExamples: matched
      .sort((left, right) => right.track.plays - left.track.plays)
      .slice(0, 20)
      .map(({ track, recordings }) => ({
        youtubeId: track.providerMediaId,
        queupTitle: track.title,
        historicalPlays: track.plays,
        recordings: recordings.map((recording) => ({
          mbid: recording.id,
          title: recording.title ?? null,
          artistCredit: artistCredit(recording),
          disambiguation: recording.disambiguation || null,
          video: recording.video ?? null,
        })),
      })),
    unmatchedExamples: unmatched
      .sort((left, right) => right.plays - left.plays)
      .slice(0, 20)
      .map((track) => ({
        youtubeId: track.providerMediaId,
        queupTitle: track.title,
        historicalPlays: track.plays,
      })),
  };

  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputFile}`);
  console.log(
    `Exact recording coverage: ${matched.length}/${sample.length} (${result.coverage.recordingMatchedPercent}%)`,
  );
  console.log(
    `Play-weighted coverage inside sample: ${matchedPlays}/${sampledPlays} (${result.coverage.playWeightedCoveragePercent}%)`,
  );
}

await main();
