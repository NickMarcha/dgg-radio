import { describe, expect, it, vi } from 'vitest';
import { isYouTubeAvailableInTargetCountry, lookupMedia, parseMediaUrl } from './media';

describe('parseMediaUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=10',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  ])('extracts a YouTube video ID from %s', (url) => {
    expect(parseMediaUrl(url)).toMatchObject({
      provider: 'youtube',
      providerMediaId: 'dQw4w9WgXcQ',
    });
  });

  it('accepts a direct SoundCloud track-shaped URL for server resolution', () => {
    expect(parseMediaUrl('https://soundcloud.com/artist/track')).toMatchObject({
      provider: 'soundcloud',
      providerMediaId: null,
    });
  });

  it('rejects unsupported sites', () => {
    expect(() => parseMediaUrl('https://example.com/song')).toThrow('Only YouTube and SoundCloud');
  });
});

describe('isYouTubeAvailableInTargetCountry', () => {
  it('allows a video without regional restrictions', () => {
    expect(isYouTubeAvailableInTargetCountry(undefined, 'AE')).toBe(true);
  });

  it('rejects a video blocked in the UAE', () => {
    expect(isYouTubeAvailableInTargetCountry({ blocked: ['AE', 'DE'] }, 'AE')).toBe(false);
  });

  it('rejects a video whose allow-list omits the UAE', () => {
    expect(isYouTubeAvailableInTargetCountry({ allowed: ['US', 'CA'] }, 'AE')).toBe(false);
  });

  it('allows a video whose allow-list contains the UAE', () => {
    expect(isYouTubeAvailableInTargetCountry({ allowed: ['US', 'ae'] }, 'AE')).toBe(true);
  });
});

describe('lookupMedia against SoundCloud', () => {
  const credentials = { youtubeApiKey: 'unused', apifyApiToken: 'apify-token' };
  const trackUrl = 'https://soundcloud.com/artist/a-track';

  const actorItem = {
    type: 'track',
    id: 2343609734,
    title: 'A Track',
    url: trackUrl,
    artworkUrl: 'https://i1.sndcdn.com/artwork.png',
    duration: 210_400,
    streamable: true,
    userName: 'Artist',
  };

  const run = (fetcher: unknown) =>
    lookupMedia(trackUrl, credentials, 'AE', fetcher as typeof fetch);

  it('resolves one track URL through the actor', async () => {
    const fetcher = vi.fn(async (_endpoint: string, _init: RequestInit) =>
      Response.json([actorItem]),
    );
    const media = await run(fetcher);

    expect(media).toEqual({
      provider: 'soundcloud',
      providerMediaId: '2343609734',
      canonicalUrl: trackUrl,
      title: 'A Track',
      artist: 'Artist',
      durationSeconds: 211,
      thumbnailUrl: 'https://i1.sndcdn.com/artwork.png',
    });

    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(endpoint).toContain('/run-sync-get-dataset-items');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer apify-token');
    expect(JSON.parse(init.body as string)).toMatchObject({
      mode: 'trackUrl',
      startUrls: [trackUrl],
      maxResults: 1,
    });
  });

  it('reports an unavailable track when the run returns nothing', async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    await expect(run(fetcher)).rejects.toMatchObject({ code: 'SOUNDCLOUD_NOT_FOUND' });
  });

  it('rejects a URL that resolves to something other than a track', async () => {
    const fetcher = vi.fn(async () => Response.json([{ ...actorItem, type: 'playlist' }]));
    await expect(run(fetcher)).rejects.toMatchObject({ code: 'SOUNDCLOUD_TRACK_REQUIRED' });
  });

  it('rejects a track SoundCloud will not stream', async () => {
    const fetcher = vi.fn(async () => Response.json([{ ...actorItem, streamable: false }]));
    await expect(run(fetcher)).rejects.toMatchObject({ code: 'SOUNDCLOUD_NOT_STREAMABLE' });
  });

  it('surfaces an actor failure as an upstream error', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(run(fetcher)).rejects.toMatchObject({
      code: 'SOUNDCLOUD_LOOKUP_FAILED',
      status: 502,
    });
  });
});
