// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistLibrary, RoomMedia, RoomUser, UserProfile } from '../shared/contracts';
import CommunityPage from './CommunityPage';

const API = 'http://api.test';

const listener: RoomUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'Alice',
  avatarUrl: null,
  role: 'listener',
  team: null,
  flair: null,
  topEmote: null,
};

const track: RoomMedia = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'youtube',
  providerMediaId: 'profile1',
  canonicalUrl: 'https://www.youtube.com/watch?v=profile1',
  title: 'Profile History Track',
  artist: 'The Requester',
  durationSeconds: 185,
  thumbnailUrl: null,
};

const profile: UserProfile = {
  user: listener,
  joinedAt: '2026-08-01T12:00:00.000Z',
  lastSeenAt: '2026-08-30T12:00:00.000Z',
  isSelf: true,
  chatCheckedAt: null,
  stats: {
    requests: 1,
    plays: 1,
    played: 1,
    skipped: 0,
    upvotes: 2,
    downvotes: 0,
    score: 2,
    averageVotesPerPlay: 2,
    averageScorePerPlay: 2,
  },
  history: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      media: track,
      requestedBy: listener,
      status: 'played',
      requestedAt: '2026-08-30T11:55:00.000Z',
      startedAt: '2026-08-30T12:00:00.000Z',
      finishedAt: '2026-08-30T12:03:05.000Z',
      upvotes: 2,
      downvotes: 0,
    },
  ],
};

const library: PlaylistLibrary = {
  playlists: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Saved tracks',
      trackCount: 0,
      updatedAt: '2026-08-30T12:00:00.000Z',
    },
  ],
  memberships: {},
};

let playlistStatus = 200;

beforeEach(() => {
  playlistStatus = 200;
  window.history.replaceState({}, '', '/profile/Alice');
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const playlistRequest = url.includes('/api/playlists');
      const body = url.endsWith('/api/me')
        ? { me: listener, listenerCount: 1 }
        : playlistRequest
          ? playlistStatus === 200
            ? library
            : { error: { code: 'PLAYLIST_LOAD_FAILED', message: 'The playlist library could not be loaded.' } }
          : profile;
      return Promise.resolve({
        ok: !playlistRequest || playlistStatus === 200,
        status: playlistRequest ? playlistStatus : 200,
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('profile history', () => {
  it('lets a signed-in listener save a track to a playlist', async () => {
    render(<CommunityPage apiUrl={API} view="profile" />);

    expect(
      await screen.findByRole('button', { name: `Save ${track.title} to a playlist` }),
    ).toBeDefined();
  });

  it('explains when playlist saving is unavailable on a profile', async () => {
    playlistStatus = 500;

    render(<CommunityPage apiUrl={API} view="profile" />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The playlist library could not be loaded. Saving to a playlist is unavailable.',
    );
  });
});
