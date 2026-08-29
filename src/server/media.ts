import ytsr from '@distube/ytsr';
import { Soundcloud } from 'soundcloud.ts';
import { parse as parseDuration } from 'tinyduration';
import { z } from 'zod';
import type { MediaProvider } from '../shared/contracts';

const youtubeIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const soundCloudHosts = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);

export interface ParsedMediaUrl {
  provider: MediaProvider;
  providerMediaId: string | null;
  url: URL;
}

export interface MediaMetadata {
  provider: MediaProvider;
  providerMediaId: string;
  /** Channel on YouTube, uploader on SoundCloud. Rules block artists by this. */
  providerArtistId: string;
  canonicalUrl: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

/**
 * What a provider says about one track, split into what it is and whether this
 * room can play it. `playbackIssue` is room policy the personal library
 * ignores: saving a track keeps it regardless, and the same issue is raised
 * again when someone asks for it in the queue.
 */
export interface MediaInspection {
  metadata: MediaMetadata;
  /**
   * Why the room cannot play it, region aside. This part is the same wherever
   * the room plays from, so it can be stored and reused as it stands.
   */
  playbackIssue: MediaLookupError | null;
  /**
   * The countries YouTube allowed or blocked, or null when it named none and
   * for SoundCloud, which has no such notion. Stored so the region question can
   * be answered again for a different playback region without a second lookup.
   */
  regionRestriction: RegionRestriction;
}

export interface SearchResult {
  provider: MediaProvider;
  url: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

export interface ParsedPlaylistUrl {
  provider: MediaProvider;
  /** A YouTube playlist id, or the SoundCloud set's own URL. */
  id: string;
}

export interface MediaLookupCredentials {
  youtubeApiKey: string;
}

export class MediaLookupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'MediaLookupError';
  }
}

export function parseMediaUrl(value: string): ParsedMediaUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaLookupError('INVALID_URL', 'Enter a valid YouTube or SoundCloud URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaLookupError('INVALID_URL', 'Only HTTP and HTTPS links are accepted.');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'youtu.be') {
    return {
      provider: 'youtube',
      providerMediaId: validateYouTubeId(url.pathname.split('/').filter(Boolean)[0]),
      url,
    };
  }

  if (youtubeHosts.has(hostname)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const candidate =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : ['shorts', 'embed', 'live'].includes(segments[0] ?? '')
          ? segments[1]
          : null;

    return {
      provider: 'youtube',
      providerMediaId: validateYouTubeId(candidate),
      url,
    };
  }

  if (soundCloudHosts.has(hostname)) {
    if (url.pathname.split('/').filter(Boolean).length < 2) {
      throw new MediaLookupError('INVALID_SOUNDCLOUD_URL', 'Link directly to a SoundCloud track.');
    }
    url.hash = '';
    return { provider: 'soundcloud', providerMediaId: null, url };
  }

  throw new MediaLookupError('UNSUPPORTED_PROVIDER', 'Only YouTube and SoundCloud links are accepted.');
}

/**
 * A playlist link, which is a different shape from a track link on both
 * providers: YouTube carries the id in `list`, SoundCloud puts `/sets/` in the
 * path.
 */
export function parsePlaylistUrl(value: string): ParsedPlaylistUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaLookupError('INVALID_URL', 'Enter a valid YouTube or SoundCloud playlist link.');
  }

  const hostname = url.hostname.toLowerCase();
  if (youtubeHosts.has(hostname)) {
    const list = url.searchParams.get('list');
    if (!list) {
      throw new MediaLookupError('INVALID_PLAYLIST_URL', 'That YouTube link has no playlist in it.');
    }
    return { provider: 'youtube', id: list };
  }

  if (soundCloudHosts.has(hostname)) {
    if (!url.pathname.toLowerCase().includes('/sets/')) {
      throw new MediaLookupError('INVALID_PLAYLIST_URL', 'Link to a SoundCloud set.');
    }
    url.hash = '';
    return { provider: 'soundcloud', id: url.toString() };
  }

  throw new MediaLookupError('UNSUPPORTED_PROVIDER', 'Only YouTube and SoundCloud playlists work.');
}

function validateYouTubeId(value: string | null | undefined): string {
  if (!value || !youtubeIdPattern.test(value)) {
    throw new MediaLookupError('INVALID_YOUTUBE_URL', 'Link directly to a YouTube video.');
  }
  return value;
}

const youtubeResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        title: z.string(),
        channelId: z.string(),
        channelTitle: z.string(),
        thumbnails: z
          .record(
            z.string(),
            z.object({
              url: z.string(),
            }),
          )
          .optional(),
        liveBroadcastContent: z.string().optional(),
      }),
      contentDetails: z.object({
        duration: z.string(),
        regionRestriction: z
          .object({
            allowed: z.array(z.string()).optional(),
            blocked: z.array(z.string()).optional(),
          })
          .optional(),
        contentRating: z.looseObject({ ytRating: z.string().optional() }).optional(),
      }),
      status: z.object({
        embeddable: z.boolean(),
        uploadStatus: z.string().optional(),
        privacyStatus: z.string().optional(),
      }),
    }),
  ),
});

type YouTubeVideo = z.infer<typeof youtubeResponseSchema>['items'][number];

/** Null when YouTube named no countries, and for SoundCloud, which has none. */
export type RegionRestriction =
  NonNullable<YouTubeVideo['contentDetails']['regionRestriction']> | null;

export function isYouTubeAvailableInTargetCountry(
  restriction: RegionRestriction,
  targetCountry: string,
): boolean {
  const country = targetCountry.toUpperCase();
  if (restriction?.blocked?.some((code) => code.toUpperCase() === country)) {
    return false;
  }
  if (restriction?.allowed && !restriction.allowed.some((code) => code.toUpperCase() === country)) {
    return false;
  }
  return true;
}

function isoDurationToSeconds(value: string): number {
  const duration = parseDuration(value);
  if (duration.years || duration.months) {
    throw new MediaLookupError('INVALID_DURATION', 'This video has an unsupported duration.');
  }
  return Math.ceil(
    (duration.weeks ?? 0) * 604_800 +
      (duration.days ?? 0) * 86_400 +
      (duration.hours ?? 0) * 3_600 +
      (duration.minutes ?? 0) * 60 +
      (duration.seconds ?? 0),
  );
}

function bestYouTubeThumbnail(
  thumbnails: Record<string, { url: string }> | undefined,
): string | null {
  return thumbnails?.maxres?.url ?? thumbnails?.high?.url ?? thumbnails?.medium?.url ?? null;
}

async function lookupYouTube(
  parsed: ParsedMediaUrl,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<MediaInspection> {
  const id = parsed.providerMediaId;
  if (!id) {
    throw new MediaLookupError('INVALID_YOUTUBE_URL', 'Link directly to a YouTube video.');
  }

  const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
  endpoint.searchParams.set('part', 'snippet,contentDetails,status');
  endpoint.searchParams.set('id', id);
  endpoint.searchParams.set('key', apiKey);

  const response = await fetcher(endpoint, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new MediaLookupError(
      'YOUTUBE_LOOKUP_FAILED',
      'YouTube could not verify this video. Try again in a moment.',
      502,
    );
  }

  const result = youtubeResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new MediaLookupError('YOUTUBE_LOOKUP_FAILED', 'YouTube returned an unexpected response.', 502);
  }

  const video = result.data.items[0];
  if (!video) {
    throw new MediaLookupError('YOUTUBE_NOT_FOUND', 'That YouTube video is unavailable.');
  }
  if (video.snippet.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none') {
    throw new MediaLookupError('YOUTUBE_LIVE_VIDEO', 'Live streams and upcoming premieres cannot join the queue.');
  }

  const durationSeconds = isoDurationToSeconds(video.contentDetails.duration);
  if (durationSeconds < 1) {
    throw new MediaLookupError('INVALID_DURATION', 'YouTube did not report a playable duration.');
  }

  return {
    metadata: {
      provider: 'youtube',
      providerMediaId: id,
      providerArtistId: video.snippet.channelId,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      title: video.snippet.title,
      artist: video.snippet.channelTitle,
      durationSeconds,
      thumbnailUrl: bestYouTubeThumbnail(video.snippet.thumbnails),
    },
    playbackIssue: youTubePlaybackIssue(video),
    regionRestriction: video.contentDetails.regionRestriction ?? null,
  };
}

/**
 * Whether the radio's own player can carry this video. These conditions belong
 * to the room rather than to the track, so a personal library keeps the track
 * anyway and hears about the problem when it is queued. The region is decided
 * separately, by `regionPlaybackIssue`, because it alone depends on a setting.
 */
function youTubePlaybackIssue(video: YouTubeVideo): MediaLookupError | null {
  if (!video.status.embeddable) {
    return new MediaLookupError('YOUTUBE_NOT_EMBEDDABLE', 'That video cannot play in the radio player.');
  }
  if (video.contentDetails.contentRating?.ytRating === 'ytAgeRestricted') {
    return new MediaLookupError(
      'YOUTUBE_AGE_RESTRICTED',
      'Age-restricted videos cannot play in the radio player.',
    );
  }
  return null;
}

/**
 * The region half of the same question, kept separate because it is the only
 * part that depends on where the room plays from. YouTube names the countries
 * once, so a stored answer settles it for every region without asking again.
 */
export function regionPlaybackIssue(
  restriction: RegionRestriction,
  targetCountry: string,
): MediaLookupError | null {
  if (isYouTubeAvailableInTargetCountry(restriction, targetCountry)) return null;
  return new MediaLookupError(
    'YOUTUBE_REGION_BLOCKED',
    `That video is not available to the playback host in ${targetCountry.toUpperCase()}.`,
  );
}

/**
 * SoundCloud's documented API now needs a paid subscription. soundcloud.ts talks
 * to the same api-v2 endpoints the website uses, and finds the public web client
 * id itself, so the radio holds no SoundCloud credentials at all.
 */
const soundCloudTrackSchema = z.object({
  kind: z.literal('track'),
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().min(1),
  duration: z.number().int().positive(),
  permalink_url: z.url(),
  artwork_url: z.url().nullable().optional(),
  streamable: z.boolean().optional(),
  policy: z.string().optional(),
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    username: z.string().min(1),
  }),
});

let soundCloudClient: Soundcloud | undefined;

function statusOf(error: unknown): number | null {
  const matched = /Status code (\d{3})/.exec(error instanceof Error ? error.message : '');
  return matched ? Number(matched[1]) : null;
}

/**
 * The web client id rotates, and the library only discovers one when it has
 * none. A 401 means the cached id went stale, so force a new one and retry once.
 */
async function resolveSoundCloudTrack(url: string): Promise<unknown> {
  soundCloudClient ??= new Soundcloud();
  try {
    return await soundCloudClient.resolve.get(url, true);
  } catch (error) {
    if (statusOf(error) !== 401) throw error;
    await soundCloudClient.api.getClientId(true);
    return soundCloudClient.resolve.get(url, true);
  }
}

async function lookupSoundCloud(parsed: ParsedMediaUrl): Promise<MediaInspection> {
  let resolved: unknown;
  try {
    resolved = await resolveSoundCloudTrack(parsed.url.toString());
  } catch (error) {
    const status = statusOf(error);
    if (status === null) throw error;
    if (status === 404) {
      throw new MediaLookupError('SOUNDCLOUD_NOT_FOUND', 'That SoundCloud track is unavailable.');
    }
    throw new MediaLookupError(
      'SOUNDCLOUD_LOOKUP_FAILED',
      'SoundCloud could not be reached. Try again in a moment.',
      502,
    );
  }

  const result = soundCloudTrackSchema.safeParse(resolved);
  if (!result.success) {
    throw new MediaLookupError('SOUNDCLOUD_TRACK_REQUIRED', 'Link directly to one SoundCloud track.');
  }
  const track = result.data;
  const playbackIssue =
    track.streamable === false || track.policy === 'BLOCK'
      ? new MediaLookupError('SOUNDCLOUD_NOT_STREAMABLE', 'That SoundCloud track is not streamable.')
      : null;

  return {
    playbackIssue,
    regionRestriction: null,
    metadata: {
      provider: 'soundcloud',
      providerMediaId: track.id,
      providerArtistId: track.user.id,
      canonicalUrl: track.permalink_url,
      title: track.title,
      artist: track.user.username,
      durationSeconds: Math.ceil(track.duration / 1_000),
      thumbnailUrl: track.artwork_url ?? null,
    },
  };
}

const youtubePlaylistSchema = z.object({
  items: z.array(z.object({ contentDetails: z.object({ videoId: z.string() }) })),
  nextPageToken: z.string().optional(),
});

/**
 * The track links inside a playlist, ready to go through the normal request
 * path so each one still faces the duration, region and rule checks.
 */
export async function listPlaylistTrackUrls(
  parsed: ParsedPlaylistUrl,
  credentials: MediaLookupCredentials,
  limit: number,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (parsed.provider === 'soundcloud') {
    let playlist: { tracks?: { permalink_url?: string }[] };
    try {
      soundCloudClient ??= new Soundcloud();
      playlist = await soundCloudClient.playlists.get(parsed.id);
    } catch (error) {
      if (statusOf(error) === 404) {
        throw new MediaLookupError('PLAYLIST_NOT_FOUND', 'That SoundCloud set is unavailable.');
      }
      throw new MediaLookupError('PLAYLIST_LOOKUP_FAILED', 'SoundCloud could not be reached.', 502);
    }
    return (playlist.tracks ?? [])
      .map((track) => track.permalink_url)
      .filter((url): url is string => Boolean(url))
      .slice(0, limit);
  }

  // playlistItems costs one quota unit per page, unlike search which costs 100.
  const urls: string[] = [];
  let pageToken: string | undefined;
  do {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    endpoint.searchParams.set('part', 'contentDetails');
    endpoint.searchParams.set('playlistId', parsed.id);
    endpoint.searchParams.set('maxResults', '50');
    endpoint.searchParams.set('key', credentials.youtubeApiKey);
    if (pageToken) endpoint.searchParams.set('pageToken', pageToken);

    const response = await fetcher(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      throw new MediaLookupError(
        'PLAYLIST_NOT_FOUND',
        'That YouTube playlist is unavailable. Private playlists cannot be read.',
      );
    }
    const page = youtubePlaylistSchema.safeParse(await response.json());
    if (!page.success) {
      throw new MediaLookupError('PLAYLIST_LOOKUP_FAILED', 'YouTube returned an unexpected playlist.', 502);
    }
    for (const item of page.data.items) {
      urls.push(`https://www.youtube.com/watch?v=${item.contentDetails.videoId}`);
    }
    pageToken = page.data.nextPageToken;
  } while (pageToken && urls.length < limit);

  return urls.slice(0, limit);
}

/**
 * Only SoundCloud is searchable. YouTube's search costs a hundred quota units a
 * call against a ten thousand a day allowance, which one busy evening would eat.
 */
export async function searchSoundCloud(query: string, limit: number): Promise<SearchResult[]> {
  soundCloudClient ??= new Soundcloud();
  let found: { collection?: unknown[] };
  try {
    found = await soundCloudClient.tracks.search({ q: query, limit });
  } catch (error) {
    if (statusOf(error) === 401) {
      await soundCloudClient.api.getClientId(true);
      found = await soundCloudClient.tracks.search({ q: query, limit });
    } else {
      throw new MediaLookupError('SEARCH_FAILED', 'SoundCloud could not be reached.', 502);
    }
  }

  return (found.collection ?? [])
    .map((entry) => soundCloudTrackSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .map(({ data: track }) => ({
      provider: 'soundcloud' as const,
      url: track.permalink_url,
      title: track.title,
      artist: track.user.username,
      durationSeconds: Math.ceil(track.duration / 1_000),
      thumbnailUrl: track.artwork_url ?? null,
    }));
}

function clockDurationToSeconds(value: string): number | null {
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const values = parts.map(Number);
  if (values.slice(1).some((part) => part > 59)) return null;

  const seconds = values.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

/**
 * Search uses YouTube's public web response rather than search.list, which
 * costs 100 Data API quota units. Queueing a result still runs the normal
 * videos.list validation before anything is stored.
 */
export async function searchYouTube(query: string, limit: number): Promise<SearchResult[]> {
  process.env.YTSR_NO_UPDATE ??= '1';

  let found: Awaited<ReturnType<typeof ytsr>>;
  try {
    found = await ytsr(query, {
      type: 'video',
      limit,
      requestOptions: { signal: AbortSignal.timeout(8_000) },
    });
  } catch {
    throw new MediaLookupError('SEARCH_FAILED', 'YouTube search could not be reached.', 502);
  }

  return found.items.flatMap((video) => {
    const durationSeconds = clockDurationToSeconds(video.duration);
    if (
      video.type !== 'video' ||
      !youtubeIdPattern.test(video.id) ||
      video.isLive ||
      video.isUpcoming ||
      durationSeconds === null
    ) {
      return [];
    }

    return [{
      provider: 'youtube' as const,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.name,
      artist: video.author?.name ?? 'Unknown channel',
      durationSeconds,
      thumbnailUrl: video.thumbnail || video.thumbnails.find((thumbnail) => thumbnail.url)?.url || null,
    }];
  });
}

export async function searchMedia(query: string, limit: number): Promise<SearchResult[]> {
  const [youtube, soundcloud] = await Promise.allSettled([
    searchYouTube(query, limit),
    searchSoundCloud(query, limit),
  ]);

  if (youtube.status === 'rejected' && soundcloud.status === 'rejected') {
    throw new MediaLookupError('SEARCH_FAILED', 'YouTube and SoundCloud could not be reached.', 502);
  }

  const youtubeResults = youtube.status === 'fulfilled' ? youtube.value : [];
  const soundCloudResults = soundcloud.status === 'fulfilled' ? soundcloud.value : [];
  const results: SearchResult[] = [];
  const resultCount = Math.max(youtubeResults.length, soundCloudResults.length);
  for (let index = 0; index < resultCount && results.length < limit; index += 1) {
    if (youtubeResults[index]) results.push(youtubeResults[index]);
    if (soundCloudResults[index] && results.length < limit) results.push(soundCloudResults[index]);
  }
  return results;
}

/**
 * Reads a link and separates the questions the providers answer together: what
 * the track is, whether this room's player can carry it, and which countries
 * it is restricted to. It asks nothing about the room, so one answer serves
 * every playback region. A link that cannot be read at all still throws,
 * because there is nothing to describe.
 */
export async function inspectMedia(
  value: string,
  credentials: MediaLookupCredentials,
  fetcher: typeof fetch = fetch,
): Promise<MediaInspection> {
  const parsed = parseMediaUrl(value);
  return parsed.provider === 'youtube'
    ? lookupYouTube(parsed, credentials.youtubeApiKey, fetcher)
    : lookupSoundCloud(parsed);
}

/** The admission view: a track the room cannot play is a failed lookup. */
export async function lookupMedia(
  value: string,
  credentials: MediaLookupCredentials,
  targetCountry = 'AE',
  fetcher: typeof fetch = fetch,
): Promise<MediaMetadata> {
  const inspected = await inspectMedia(value, credentials, fetcher);
  const issue =
    inspected.playbackIssue ?? regionPlaybackIssue(inspected.regionRestriction, targetCountry);
  if (issue) throw issue;
  return inspected.metadata;
}
