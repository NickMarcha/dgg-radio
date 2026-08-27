import { describe, expect, it } from 'vitest';
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
