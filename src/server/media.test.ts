const { resolveTrack, forceNewClientId, searchTracks, youtubeSearch } = vi.hoisted(() => ({
  resolveTrack: vi.fn(),
  forceNewClientId: vi.fn(),
  searchTracks: vi.fn(),
  youtubeSearch: vi.fn(),
}));

vi.mock('@distube/ytsr', () => ({ default: youtubeSearch }));

vi.mock('soundcloud.ts', () => {
  class Soundcloud {
    resolve = { get: resolveTrack };
    api = { getClientId: forceNewClientId };
    tracks = { search: searchTracks };
  }
  return { Soundcloud, default: Soundcloud };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isYouTubeAvailableInTargetCountry,
  lookupMedia,
  parseMediaUrl,
  parsePlaylistUrl,
  searchMedia,
  searchYouTube,
} from './media';

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

describe('parsePlaylistUrl', () => {
  it.each([
    ['https://www.youtube.com/playlist?list=PL123', 'PL123'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL456', 'PL456'],
  ])('takes the list id out of %s', (url, id) => {
    expect(parsePlaylistUrl(url)).toEqual({ provider: 'youtube', id });
  });

  it('keeps a SoundCloud set as its own URL', () => {
    expect(parsePlaylistUrl('https://soundcloud.com/artist/sets/a-set#play')).toEqual({
      provider: 'soundcloud',
      id: 'https://soundcloud.com/artist/sets/a-set',
    });
  });

  it('rejects a track link that carries no playlist', () => {
    expect(() => parsePlaylistUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toThrow(
      'no playlist',
    );
    expect(() => parsePlaylistUrl('https://soundcloud.com/artist/a-track')).toThrow(
      'Link to a SoundCloud set',
    );
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

describe('YouTube search', () => {
  const video = (overrides: Record<string, unknown> = {}) => ({
    type: 'video',
    id: 'dQw4w9WgXcQ',
    name: 'Never Gonna Give You Up',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    thumbnails: [],
    isUpcoming: false,
    upcoming: null,
    isLive: false,
    badges: [],
    views: 1,
    duration: '3:32',
    author: {
      name: 'Rick Astley',
      channelID: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      url: 'https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw',
      bestAvatar: { url: null, width: 0, height: 0 },
      avatars: [],
      ownerBadges: [],
      verified: true,
    },
    ...overrides,
  });

  beforeEach(() => {
    youtubeSearch.mockReset();
    searchTracks.mockReset();
  });

  it('loads the installed search package as a callable function', async () => {
    const actual = await vi.importActual<typeof import('@distube/ytsr')>('@distube/ytsr');
    expect(typeof (actual as unknown as { default: unknown }).default).toBe('function');
  });

  it('maps videos and drops live, upcoming, and durationless results', async () => {
    youtubeSearch.mockResolvedValue({
      query: 'rick astley',
      results: 4,
      items: [
        video(),
        video({ id: 'liveVideo01', isLive: true }),
        video({ id: 'upcoming001', isUpcoming: true }),
        video({ id: 'noDuration1', duration: '' }),
      ],
    });

    await expect(searchYouTube('rick astley', 5)).resolves.toEqual([
      {
        provider: 'youtube',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Never Gonna Give You Up',
        artist: 'Rick Astley',
        durationSeconds: 212,
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      },
    ]);
    expect(youtubeSearch).toHaveBeenCalledWith(
      'rick astley',
      expect.objectContaining({ type: 'video', limit: 5 }),
    );
  });

  it('interleaves providers and keeps SoundCloud results when YouTube search fails', async () => {
    const soundCloudTrack = {
      kind: 'track',
      id: 123,
      title: 'A SoundCloud Track',
      duration: 90_000,
      permalink_url: 'https://soundcloud.com/artist/a-track',
      artwork_url: null,
      user: { id: 456, username: 'Artist' },
    };
    youtubeSearch.mockResolvedValue({ query: 'track', results: 1, items: [video()] });
    searchTracks.mockResolvedValue({ collection: [soundCloudTrack] });

    await expect(searchMedia('track', 15)).resolves.toMatchObject([
      { provider: 'youtube' },
      { provider: 'soundcloud' },
    ]);

    youtubeSearch.mockRejectedValueOnce(new Error('YouTube changed its response'));
    await expect(searchMedia('track', 15)).resolves.toEqual([
      {
        provider: 'soundcloud',
        url: soundCloudTrack.permalink_url,
        title: soundCloudTrack.title,
        artist: soundCloudTrack.user.username,
        durationSeconds: 90,
        thumbnailUrl: null,
      },
    ]);
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
