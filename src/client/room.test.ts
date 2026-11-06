import { describe, expect, it } from 'vitest';
import { roomPath, roomSlugFromPath, roomSlugFromSearch } from './room';

describe('which room a page is about', () => {
  it('reads a room page from its path, and treats every other page as the main room', () => {
    expect(roomSlugFromPath('/r/late-night')).toBe('late-night');
    expect(roomSlugFromPath('/r/Late-Night/')).toBe('late-night');
    expect(roomSlugFromPath('/')).toBe('main');
    expect(roomSlugFromPath('/player')).toBe('main');
    expect(roomSlugFromPath('/r/')).toBe('main');
    expect(roomSlugFromPath('/r/no spaces')).toBe('main');
  });

  it('reads an embed room from the query string', () => {
    expect(roomSlugFromSearch('?room=late-night&captions=on')).toBe('late-night');
    expect(roomSlugFromSearch('?captions=on')).toBe('main');
    expect(roomSlugFromSearch('?room=../admin')).toBe('main');
  });

  it('keeps the main room at the root', () => {
    expect(roomPath('main')).toBe('/');
    expect(roomPath('late-night')).toBe('/r/late-night');
  });
});
