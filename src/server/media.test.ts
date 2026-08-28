import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isYouTubeAvailableInTargetCountry, parseMediaUrl } from './media';

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
  const credentials = {
    youtubeApiKey: 'unused',
    soundCloudClientId: 'client-id',
    soundCloudClientSecret: 'client-secret',
  };
  const trackUrl = 'https://soundcloud.com/artist/a-track';

  // The token cache lives in module scope, which is what makes it a cache in a
  // long-running server. Each test needs its own module instance.
  beforeEach(() => vi.resetModules());
  const freshLookup = async () => (await import('./media')).lookupMedia;

  function stubSoundCloud() {
    return vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://secure.soundcloud.com/oauth/token')) {
        return Response.json({ access_token: 'token-value', expires_in: 3600 });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization !== 'OAuth token-value') {
        return new Response('unauthorized', { status: 403 });
      }
      return Response.json({
        id: 12345,
        kind: 'track',
        title: 'A Track',
        duration: 210_000,
        permalink_url: trackUrl,
        artwork_url: null,
        streamable: true,
        user: { username: 'Artist' },
      });
    });
  }

  const tokenRequests = (fetcher: ReturnType<typeof stubSoundCloud>) =>
    fetcher.mock.calls.filter(([input]) =>
      String(input).startsWith('https://secure.soundcloud.com/oauth/token'),
    );

  it('exchanges credentials for a token and resolves the track with it', async () => {
    const lookup = await freshLookup();
    const fetcher = stubSoundCloud();
    const media = await lookup(trackUrl, credentials, 'AE', fetcher as unknown as typeof fetch);

    expect(media).toMatchObject({
      provider: 'soundcloud',
      providerMediaId: '12345',
      artist: 'Artist',
      durationSeconds: 210,
    });

    const [tokenCall] = tokenRequests(fetcher);
    expect(tokenCall?.[1]).toMatchObject({
      method: 'POST',
      body: 'grant_type=client_credentials',
    });
    expect((tokenCall?.[1] as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    });
  });

  it('reuses a live token instead of asking for another one', async () => {
    const lookup = await freshLookup();
    const fetcher = stubSoundCloud();
    await lookup(trackUrl, credentials, 'AE', fetcher as unknown as typeof fetch);
    await lookup(trackUrl, credentials, 'AE', fetcher as unknown as typeof fetch);

    expect(tokenRequests(fetcher)).toHaveLength(1);
  });

  it('reports a credential failure rather than a track failure', async () => {
    const lookup = await freshLookup();
    const fetcher = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      lookup(trackUrl, credentials, 'AE', fetcher as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'SOUNDCLOUD_AUTH_FAILED' });
  });
});
