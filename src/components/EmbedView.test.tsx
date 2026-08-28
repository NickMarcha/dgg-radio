import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSnapshot } from '../shared/contracts';
import EmbedView from './EmbedView';

const state = vi.hoisted(() => ({ room: null as RoomSnapshot | null }));

vi.mock('./useRoomSnapshot', () => ({
  useRoomSnapshot: () => ({ room: state.room, error: null }),
}));

function roomSnapshot(): RoomSnapshot {
  const startedAt = new Date('2026-08-28T12:00:00.000Z').toISOString();
  return {
    serverTime: new Date('2026-08-28T12:00:30.000Z').toISOString(),
    revision: 1,
    listenerCount: 1,
    settings: {
      description: '',
      maxDurationSeconds: 1_800,
      targetCountry: 'US',
      skipMode: 'absolute',
      skipDownvotes: 3,
      skipRatioPercent: 50,
      revealRequester: true,
    },
    me: null,
    current: {
      id: '11111111-1111-4111-8111-111111111111',
      media: {
        id: '22222222-2222-4222-8222-222222222222',
        provider: 'youtube',
        providerMediaId: 'M7lc1UVf-VE',
        canonicalUrl: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        title: 'YouTube IFrame API Demo',
        artist: 'YouTube Developers',
        durationSeconds: 120,
        thumbnailUrl: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg',
      },
      requestedBy: null,
      status: 'playing',
      requestedAt: startedAt,
      startedAt,
      upvotes: 0,
      downvotes: 0,
      myVote: 0,
    },
    queue: [],
    myQueue: [],
    rules: [],
    selectorStats: [],
  };
}

describe('OBS embeds', () => {
  beforeEach(() => {
    state.room = roomSnapshot();
  });

  it('renders only the provider mount in player mode', () => {
    const html = renderToStaticMarkup(
      createElement(EmbedView, { apiUrl: 'https://api.example.com', mode: 'player' }),
    );

    expect(html).toContain('embed-media-youtube');
    expect(html).not.toContain('YouTube IFrame API Demo');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });

  it('renders artwork and track text without a media player in playing mode', () => {
    const html = renderToStaticMarkup(
      createElement(EmbedView, { apiUrl: 'https://api.example.com', mode: 'playing' }),
    );

    expect(html).toContain('YouTube IFrame API Demo');
    expect(html).toContain('YouTube Developers');
    expect(html).toContain('hqdefault.jpg');
    expect(html).not.toContain('embed-media-provider');
    expect(html).not.toContain('<iframe');
  });

  it('renders an empty transparent overlay when the room is idle', () => {
    state.room = { ...roomSnapshot(), current: null };

    const html = renderToStaticMarkup(
      createElement(EmbedView, { apiUrl: 'https://api.example.com', mode: 'playing' }),
    );

    expect(html).toBe('<main class="embed-root" aria-label="Nothing playing"></main>');
  });
});
