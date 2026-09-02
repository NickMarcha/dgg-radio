// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HistoryEntry,
  LegacyHistoryPage,
  PlaylistLibrary,
  RoomMedia,
  RoomUser,
  UserProfile,
} from '../shared/contracts';
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
/** What `/api/history/legacy` answers. Empty by default, as an un-imported room is. */
let legacyPage: LegacyHistoryPage = { entries: [], total: 0, nextCursor: null };
const roomHistory: HistoryEntry[] = [
  { ...profile.history[0]!, id: '55555555-5555-4555-8555-555555555555' },
];

beforeEach(() => {
  playlistStatus = 200;
  legacyPage = { entries: [], total: 0, nextCursor: null };
  window.history.replaceState({}, '', '/profile/Alice');
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const playlistRequest = url.includes('/api/playlists');
      const body = url.endsWith('/api/me')
        ? { me: listener, listenerCount: 1 }
        : url.includes('/api/history/legacy')
          ? legacyPage
          : url.includes('/api/history')
            ? { history: roomHistory }
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


describe('the QueUp archive on the history page', () => {
  const play = (id: string, title: string) => ({
    id,
    provider: 'youtube' as const,
    title,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    durationSeconds: 200,
    thumbnailUrl: null,
    requesterName: 'queup-name',
    playedAt: '2025-06-01T12:00:00.000Z',
    upvotes: 3,
    downvotes: 1,
    skipped: false,
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/history');
  });

  it('shows the archive below the live history, and says whose names those are', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 47_982, nextCursor: null };

    render(<CommunityPage apiUrl={API} view="history" />);

    expect(await screen.findByText('Before DGG Radio')).toBeDefined();
    expect(screen.getByText(/47,982 plays imported from QueUp/)).toBeDefined();
    expect(screen.getByText('An Archived Track')).toBeDefined();
    expect(screen.getByText('queup-name')).toBeDefined();
  });

  it('says nothing at all when nothing has been imported', async () => {
    render(<CommunityPage apiUrl={API} view="history" />);

    expect(await screen.findByText('History')).toBeDefined();
    expect(screen.queryByText('Before DGG Radio')).toBeNull();
  });

  it('offers older plays only while there are more to read', async () => {
    legacyPage = {
      entries: [play('archived001', 'An Archived Track')],
      total: 2,
      nextCursor: '2025-06-01T12:00:00.000Z',
    };

    render(<CommunityPage apiUrl={API} view="history" />);

    expect(await screen.findByRole('button', { name: 'Load older' })).toBeDefined();
  });
});
