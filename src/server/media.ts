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

type RegionRestriction = z.infer<
  typeof youtubeResponseSchema
>['items'][number]['contentDetails']['regionRestriction'];

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
  targetCountry: string,
  fetcher: typeof fetch,
): Promise<MediaMetadata> {
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
  if (!video.status.embeddable) {
    throw new MediaLookupError('YOUTUBE_NOT_EMBEDDABLE', 'That video cannot play in the radio player.');
  }
  if (!isYouTubeAvailableInTargetCountry(video.contentDetails.regionRestriction, targetCountry)) {
    throw new MediaLookupError(
      'YOUTUBE_BLOCKED_IN_UAE',
      'That video is not available to the playback host in the UAE.',
    );
  }
  if (video.contentDetails.contentRating?.ytRating === 'ytAgeRestricted') {
    throw new MediaLookupError(
      'YOUTUBE_AGE_RESTRICTED',
      'Age-restricted videos cannot play in the radio player.',
    );
  }
  if (video.snippet.liveBroadcastContent && video.snippet.liveBroadcastContent !== 'none') {
    throw new MediaLookupError('YOUTUBE_LIVE_VIDEO', 'Live streams and upcoming premieres cannot join the queue.');
  }

  const durationSeconds = isoDurationToSeconds(video.contentDetails.duration);
  if (durationSeconds < 1) {
    throw new MediaLookupError('INVALID_DURATION', 'YouTube did not report a playable duration.');
  }

  return {
    provider: 'youtube',
    providerMediaId: id,
    providerArtistId: video.snippet.channelId,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: video.snippet.title,
    artist: video.snippet.channelTitle,
    durationSeconds,
    thumbnailUrl: bestYouTubeThumbnail(video.snippet.thumbnails),
  };
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

async function lookupSoundCloud(parsed: ParsedMediaUrl): Promise<MediaMetadata> {
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
  if (track.streamable === false || track.policy === 'BLOCK') {
    throw new MediaLookupError('SOUNDCLOUD_NOT_STREAMABLE', 'That SoundCloud track is not streamable.');
  }

  return {
    provider: 'soundcloud',
    providerMediaId: track.id,
    providerArtistId: track.user.id,
    canonicalUrl: track.permalink_url,
    title: track.title,
    artist: track.user.username,
    durationSeconds: Math.ceil(track.duration / 1_000),
    thumbnailUrl: track.artwork_url ?? null,
  };
}

export async function lookupMedia(
  value: string,
  credentials: MediaLookupCredentials,
  targetCountry = 'AE',
  fetcher: typeof fetch = fetch,
): Promise<MediaMetadata> {
  const parsed = parseMediaUrl(value);
  return parsed.provider === 'youtube'
    ? lookupYouTube(parsed, credentials.youtubeApiKey, targetCountry, fetcher)
    : lookupSoundCloud(parsed);
}
