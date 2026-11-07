import { describe, expect, it } from 'vitest';
import { stationPath, stationSlugFromPath, stationSlugFromSearch } from './station';

describe('which station a page is about', () => {
  it('reads a station page from its path, and treats every other page as the main station', () => {
    expect(stationSlugFromPath('/s/late-night')).toBe('late-night');
    expect(stationSlugFromPath('/s/Late-Night/')).toBe('late-night');
    expect(stationSlugFromPath('/')).toBe('main');
    expect(stationSlugFromPath('/player')).toBe('main');
    expect(stationSlugFromPath('/s/')).toBe('main');
    expect(stationSlugFromPath('/s/no spaces')).toBe('main');
  });

  it('reads an embed station from the query string', () => {
    expect(stationSlugFromSearch('?station=late-night&captions=on')).toBe('late-night');
    expect(stationSlugFromSearch('?captions=on')).toBe('main');
    expect(stationSlugFromSearch('?station=../admin')).toBe('main');
  });

  it('keeps the main station at the root', () => {
    expect(stationPath('main')).toBe('/');
    expect(stationPath('late-night')).toBe('/s/late-night');
  });
});
