const { resolveTrack, forceNewClientId } = vi.hoisted(() => ({
  resolveTrack: vi.fn(),
  forceNewClientId: vi.fn(),
}));

vi.mock('soundcloud.ts', () => {
  class Soundcloud {
    resolve = { get: resolveTrack };
    api = { getClientId: forceNewClientId };
  }
  return { Soundcloud, default: Soundcloud };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const credentials = { youtubeApiKey: 'unused' };
  const trackUrl = 'https://soundcloud.com/artist/a-track';

  const resolved = {
    kind: 'track',
    id: 2343609734,
    title: 'A Track',
    duration: 210_400,
    permalink_url: trackUrl,
    artwork_url: 'https://i1.sndcdn.com/artwork.png',
    streamable: true,
    policy: 'MONETIZE',
    user: { id: 987654, username: 'Artist' },
  };

  const run = () => lookupMedia(trackUrl, credentials, 'AE');

  beforeEach(() => {
    resolveTrack.mockReset();
    forceNewClientId.mockReset();
  });

  // The package sets both `export default` and `module.exports.default`, so a
  // default import lands on a wrapper object rather than the class. Mocked tests
  // cannot see that; this checks the real module.
  it('exports a constructor that is actually usable', async () => {
    const actual = await vi.importActual<typeof import('soundcloud.ts')>('soundcloud.ts');
    const client = new actual.Soundcloud();
    expect(typeof client.resolve.get).toBe('function');
    expect(typeof client.api.getClientId).toBe('function');
  });

  it('maps a resolved track onto the room media shape', async () => {
    resolveTrack.mockResolvedValue(resolved);

    await expect(run()).resolves.toEqual({
      provider: 'soundcloud',
      providerMediaId: '2343609734',
      providerArtistId: '987654',
      canonicalUrl: trackUrl,
      title: 'A Track',
      artist: 'Artist',
      durationSeconds: 211,
      thumbnailUrl: 'https://i1.sndcdn.com/artwork.png',
    });
    expect(resolveTrack).toHaveBeenCalledWith(trackUrl, true);
  });

  it('forces a new client id and retries once when the cached one is stale', async () => {
    resolveTrack.mockRejectedValueOnce(new Error('Status code 401')).mockResolvedValueOnce(resolved);

    await expect(run()).resolves.toMatchObject({ providerMediaId: '2343609734' });
    expect(forceNewClientId).toHaveBeenCalledWith(true);
    expect(resolveTrack).toHaveBeenCalledTimes(2);
  });

  it('gives up if the track is still unreachable after a new client id', async () => {
    resolveTrack.mockRejectedValue(new Error('Status code 401'));

    await expect(run()).rejects.toMatchObject({ code: 'SOUNDCLOUD_LOOKUP_FAILED', status: 502 });
    expect(forceNewClientId).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable track on a 404', async () => {
    resolveTrack.mockRejectedValue(new Error('Status code 404'));
    await expect(run()).rejects.toMatchObject({ code: 'SOUNDCLOUD_NOT_FOUND' });
    expect(forceNewClientId).not.toHaveBeenCalled();
  });

  it('rejects a URL that resolves to something other than a track', async () => {
    resolveTrack.mockResolvedValue({ ...resolved, kind: 'playlist' });
    await expect(run()).rejects.toMatchObject({ code: 'SOUNDCLOUD_TRACK_REQUIRED' });
  });

  it.each([
    ['not streamable', { streamable: false }],
    ['blocked by policy', { policy: 'BLOCK' }],
  ])('rejects a track that is %s', async (_label, override) => {
    resolveTrack.mockResolvedValue({ ...resolved, ...override });
    await expect(run()).rejects.toMatchObject({ code: 'SOUNDCLOUD_NOT_STREAMABLE' });
  });
});
