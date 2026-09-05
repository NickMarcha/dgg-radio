/**
 * PROTOTYPE: find where genre actually lives in MusicBrainz for the tracks the
 * room plays, and how often a Discogs link is available as a second source.
 *
 * The enrichment comparison collected `genres` from search results, which
 * always answer an empty array: the search endpoint does not return genres at
 * all. Genres only arrive from a lookup with `inc=genres`, and they can sit on
 * the recording, its release group, or the artist. This measures all three.
 *
 * MusicBrainz permits one request per second per source IP. This script starts
 * requests at least 1.5 seconds apart, sends a meaningful User-Agent, and
 * caches every response in the OS temporary directory by complete URL and
 * request headers.
 *
 *   npx tsx scripts/musicbrainz-genre-source.prototype.ts \
 *     [musicbrainz-youtube-enrichment-comparison.json]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
const REQUEST_SPACING_MS = 1_500;
const cacheDirectory = join(tmpdir(), 'dggradio-musicbrainz-youtube-enriched-cache');
const outputFile = join(tmpdir(), 'dggradio-musicbrainz-genre-source.json');

interface Genre {
  name?: string;
  count?: number;
}

interface Relation {
  type?: string;
  url?: { resource?: string };
}

interface ReleaseGroup {
  id?: string;
  title?: string;
}

interface Release {
  id?: string;
  title?: string;
  'release-group'?: ReleaseGroup;
}

interface ArtistCredit {
  name?: string;
  artist?: { id?: string; name?: string };
}

interface RecordingLookup {
  id?: string;
  title?: string;
  genres?: Genre[];
  tags?: Genre[];
  releases?: Release[];
  'artist-credit'?: ArtistCredit[];
}

interface ReleaseGroupLookup {
  id?: string;
  title?: string;
  genres?: Genre[];
  tags?: Genre[];
  relations?: Relation[];
}

interface ArtistLookup {
  id?: string;
  name?: string;
  genres?: Genre[];
  tags?: Genre[];
  relations?: Relation[];
}

interface Candidate {
  mbid: string;
  score: number;
  title: string | null;
  artistCredit: string | null;
  songMetadataMatches: boolean;
}

interface CardResult {
  key: string;
  sourceYoutubeId: string;
  watchTitle: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  strategies: Record<string, { candidates?: Candidate[]; error?: string | null }>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
      const delay =
        retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
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

function lookup(entity: string, mbid: string, inc: string): URL {
  const endpoint = new URL(`https://musicbrainz.org/ws/2/${entity}/${mbid}`);
  endpoint.searchParams.set('inc', inc);
  endpoint.searchParams.set('fmt', 'json');
  return endpoint;
}

function names(genres: Genre[] | undefined): string[] {
  return genres?.flatMap((genre) => (genre.name ? [genre.name] : [])) ?? [];
}

function discogsUrls(relations: Relation[] | undefined): string[] {
  return (
    relations?.flatMap((relation) =>
      relation.url?.resource?.includes('discogs.com') ? [relation.url.resource] : [],
    ) ?? []
  );
}

async function main(): Promise<void> {
  const inputFile =
    process.argv[2] ?? join(tmpdir(), 'dggradio-musicbrainz-youtube-enrichment-comparison.json');
  const comparison = JSON.parse(await readFile(inputFile, 'utf8')) as { results: CardResult[] };
  await mkdir(cacheDirectory, { recursive: true });

  // Only cards the song-level query actually resolved are worth enriching.
  const accepted = comparison.results.flatMap((card) => {
    const top = card.strategies.songTitleArtist?.candidates?.[0];
    return top && top.songMetadataMatches ? [{ card, mbid: top.mbid }] : [];
  });

  console.log(`Enriching ${accepted.length} accepted recordings of ${comparison.results.length} cards`);

  const rows = [];
  for (const [index, entry] of accepted.entries()) {
    if ((index + 1) % 10 === 0) console.log(`${index + 1}/${accepted.length} recordings enriched`);

    const recording = await cachedJson<RecordingLookup>(
      lookup('recording', entry.mbid, 'genres+tags+artist-credits+releases+release-groups'),
    );

    const releaseGroupIds = [
      ...new Set(
        recording.releases?.flatMap((release) =>
          release['release-group']?.id ? [release['release-group'].id] : [],
        ) ?? [],
      ),
    ];
    const artistIds = [
      ...new Set(
        recording['artist-credit']?.flatMap((credit) => (credit.artist?.id ? [credit.artist.id] : [])) ?? [],
      ),
    ];

    // The first release group is the one a display would pick. Looking up all
    // of them would multiply requests for a marginal coverage gain.
    const primaryReleaseGroupId = releaseGroupIds[0] ?? null;
    const releaseGroup = primaryReleaseGroupId
      ? await cachedJson<ReleaseGroupLookup>(
          lookup('release-group', primaryReleaseGroupId, 'genres+tags+url-rels'),
        )
      : null;

    const primaryArtistId = artistIds[0] ?? null;
    const artist = primaryArtistId
      ? await cachedJson<ArtistLookup>(lookup('artist', primaryArtistId, 'genres+tags+url-rels'))
      : null;

    rows.push({
      key: entry.card.key,
      youtubeId: entry.card.sourceYoutubeId,
      youtubeTitle: entry.card.title,
      youtubeArtist: entry.card.artist,
      recordingMbid: entry.mbid,
      recordingTitle: recording.title ?? null,
      releaseGroupMbid: primaryReleaseGroupId,
      releaseGroupTitle: releaseGroup?.title ?? null,
      artistMbid: primaryArtistId,
      artistName: artist?.name ?? null,
      recordingGenres: names(recording.genres),
      recordingTags: names(recording.tags),
      releaseGroupGenres: names(releaseGroup?.genres),
      releaseGroupTags: names(releaseGroup?.tags),
      artistGenres: names(artist?.genres),
      artistTags: names(artist?.tags),
      releaseGroupDiscogsUrls: discogsUrls(releaseGroup?.relations),
      artistDiscogsUrls: discogsUrls(artist?.relations),
    });
  }

  const withRecording = rows.filter((row) => row.recordingGenres.length > 0).length;
  const withReleaseGroup = rows.filter((row) => row.releaseGroupGenres.length > 0).length;
  const withArtist = rows.filter((row) => row.artistGenres.length > 0).length;
  const withAnyGenre = rows.filter(
    (row) => row.recordingGenres.length + row.releaseGroupGenres.length + row.artistGenres.length > 0,
  ).length;
  const withAnyTag = rows.filter(
    (row) => row.recordingTags.length + row.releaseGroupTags.length + row.artistTags.length > 0,
  ).length;
  const withDiscogs = rows.filter(
    (row) => row.releaseGroupDiscogsUrls.length + row.artistDiscogsUrls.length > 0,
  ).length;
  const noGenreButDiscogs = rows.filter(
    (row) =>
      row.recordingGenres.length + row.releaseGroupGenres.length + row.artistGenres.length === 0 &&
      row.releaseGroupDiscogsUrls.length + row.artistDiscogsUrls.length > 0,
  ).length;

  const percent = (value: number) => Number(((value / Math.max(rows.length, 1)) * 100).toFixed(2));

  const summary = {
    generatedAt: new Date().toISOString(),
    sourceComparison: inputFile,
    cards: comparison.results.length,
    acceptedRecordings: rows.length,
    genreLevels: {
      recording: { count: withRecording, percent: percent(withRecording) },
      releaseGroup: { count: withReleaseGroup, percent: percent(withReleaseGroup) },
      artist: { count: withArtist, percent: percent(withArtist) },
      anyLevel: { count: withAnyGenre, percent: percent(withAnyGenre) },
      anyTagFallback: { count: withAnyTag, percent: percent(withAnyTag) },
    },
    discogs: {
      linked: { count: withDiscogs, percent: percent(withDiscogs) },
      wouldFillGenreGap: { count: noGenreButDiscogs, percent: percent(noGenreButDiscogs) },
    },
    requests: { networkRequests, cachedRequests },
  };

  await writeFile(outputFile, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log(`Wrote ${outputFile}`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
