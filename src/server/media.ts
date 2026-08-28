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
  canonicalUrl: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

export interface MediaLookupCredentials {
  youtubeApiKey: string;
  apifyApiToken: string;
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
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: video.snippet.title,
    artist: video.snippet.channelTitle,
    durationSeconds,
    thumbnailUrl: bestYouTubeThumbnail(video.snippet.thumbnails),
  };
}

/**
 * SoundCloud's own API now requires a paid subscription, so track metadata comes
 * from an Apify actor instead. One track URL is a single synchronous run.
 */
const SOUNDCLOUD_ACTOR = 'PGINBOPOGlNeBsYci';

const apifyTrackSchema = z.object({
  type: z.literal('track'),
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().min(1),
  url: z.url(),
  duration: z.number().int().positive(),
  artworkUrl: z.url().nullable().optional(),
  userName: z.string().min(1),
  streamable: z.boolean().optional(),
});

async function lookupSoundCloud(
  parsed: ParsedMediaUrl,
  apifyApiToken: string,
  fetcher: typeof fetch,
): Promise<MediaMetadata> {
  const endpoint = `https://api.apify.com/v2/acts/${SOUNDCLOUD_ACTOR}/run-sync-get-dataset-items`;
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apifyApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'trackUrl',
      startUrls: [parsed.url.toString()],
      maxResults: 1,
      includeUserDetails: false,
    }),
    // A scrape run is slower than a plain API read, so this gets its own budget.
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    throw new MediaLookupError(
      'SOUNDCLOUD_LOOKUP_FAILED',
      'SoundCloud could not be reached. Try again in a moment.',
      502,
    );
  }

  const items: unknown = await response.json().catch(() => null);
  const first = Array.isArray(items) ? items[0] : undefined;
  if (first === undefined) {
    throw new MediaLookupError('SOUNDCLOUD_NOT_FOUND', 'That SoundCloud track is unavailable.');
  }

  const result = apifyTrackSchema.safeParse(first);
  if (!result.success) {
    throw new MediaLookupError('SOUNDCLOUD_TRACK_REQUIRED', 'Link directly to one SoundCloud track.');
  }
  const track = result.data;
  if (track.streamable === false) {
    throw new MediaLookupError('SOUNDCLOUD_NOT_STREAMABLE', 'That SoundCloud track is not streamable.');
  }

  return {
    provider: 'soundcloud',
    providerMediaId: track.id,
    canonicalUrl: track.url,
    title: track.title,
    artist: track.userName,
    durationSeconds: Math.ceil(track.duration / 1_000),
    thumbnailUrl: track.artworkUrl ?? null,
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
    : lookupSoundCloud(parsed, credentials.apifyApiToken, fetcher);
}
