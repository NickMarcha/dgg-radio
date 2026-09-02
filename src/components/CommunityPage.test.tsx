// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  providerArtistId: 'channel-profile1',
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
      genres: null,
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
/** The media row an archived track resolves to the first time it is saved. */
const resolvedMediaId = '66666666-6666-4666-8666-666666666666';
/** What `/api/history/legacy` answers. Empty by default, as an un-imported room is. */
let legacyPage: LegacyHistoryPage = { entries: [], total: 0 };
const roomHistory: HistoryEntry[] = [
  { ...profile.history[0]!, id: '55555555-5555-4555-8555-555555555555' },
];

beforeEach(() => {
  playlistStatus = 200;
  legacyPage = { entries: [], total: 0 };
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
            ? { entries: roomHistory, total: roomHistory.length }
            : url.includes('/legacy/')
              ? { mediaId: resolvedMediaId, saved: true }
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
    providerMediaId: id,
    title,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    durationSeconds: 200,
    thumbnailUrl: null,
    mediaId: null,
    genres: null,
    requesterName: 'queup-name',
    playedAt: '2025-06-01T12:00:00.000Z',
    upvotes: 3,
    downvotes: 1,
    skipped: false,
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/history');
  });

  /** Opens the archive tab, which is not the one the page starts on. */
  async function openArchive() {
    fireEvent.click(await screen.findByRole('tab', { name: /QueUp/ }));
  }

  it('starts on the room own history and keeps the archive in a second tab', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 47_982 };

    render(<CommunityPage apiUrl={API} view="history" />);

    const archiveTab = await screen.findByRole('tab', { name: /QueUp/ });
    expect(screen.getByRole('tab', { name: /DGG Radio/ }).getAttribute('aria-selected')).toBe('true');
    expect(archiveTab.getAttribute('aria-selected')).toBe('false');
    expect(archiveTab.textContent).toContain('47,982');
    expect(screen.getByText(track.title)).toBeDefined();
    expect(screen.queryByText('An Archived Track')).toBeNull();

    fireEvent.click(archiveTab);

    expect(screen.getByText('An Archived Track')).toBeDefined();
    expect(screen.getByText('queup-name')).toBeDefined();
    expect(screen.queryByText(track.title)).toBeNull();
  });

  it('offers no archive tab at all when nothing has been imported', async () => {
    render(<CommunityPage apiUrl={API} view="history" />);

    expect(await screen.findByRole('heading', { name: 'History' })).toBeDefined();
    await waitFor(() => expect(screen.getByText(track.title)).toBeDefined());
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('numbers the pages, and asks for the one that was clicked', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 120 };

    render(<CommunityPage apiUrl={API} view="history" />);
    await openArchive();

    // 120 archived plays at 50 a page.
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Page 4' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) =>
          String(input).includes('/api/history/legacy?limit=50&page=2'),
        ),
      ).toBe(true),
    );
  });

  it('keeps the tab, the search and the page in a link somebody can send', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 120 };

    render(<CommunityPage apiUrl={API} view="history" />);
    await openArchive();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => expect(window.location.search).toBe('?tab=queup&page=2'));
  });

  it('opens on the tab, search and page a shared link names', async () => {
    window.history.replaceState({}, '', '/history?tab=queup&q=archived&page=2');
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 120 };

    render(<CommunityPage apiUrl={API} view="history" />);

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) =>
          String(input).includes('/api/history/legacy?limit=50&page=2&q=archived'),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole('tab', { name: /QueUp/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Search the history').value).toBe('archived');
  });

  it('falls back to the last page a search actually reaches', async () => {
    window.history.replaceState({}, '', '/history?tab=queup&page=40');
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 120 };

    render(<CommunityPage apiUrl={API} view="history" />);

    // 120 plays is three pages, so page 40 is nobody's page.
    await waitFor(() => expect(window.location.search).toBe('?tab=queup&page=3'));
  });

  it('searches both histories at once, and each tab counts its own matches', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 3 };

    render(<CommunityPage apiUrl={API} view="history" />);
    await screen.findByRole('tab', { name: /QueUp/ });

    fireEvent.change(screen.getByLabelText('Search the history'), {
      target: { value: 'radiohead' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    await waitFor(() => {
      const searched = vi
        .mocked(fetch)
        .mock.calls.map(([input]) => String(input))
        .filter((url) => url.includes('q=radiohead'));
      expect(searched.some((url) => url.includes('/api/history?'))).toBe(true);
      expect(searched.some((url) => url.includes('/api/history/legacy?'))).toBe(true);
    });
    expect(screen.getByRole('tab', { name: /QueUp/ }).textContent).toContain('3');
  });

  it('requests a track from either history through the room own queue', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 1 };

    render(<CommunityPage apiUrl={API} view="history" />);

    fireEvent.click(
      await screen.findByRole('button', { name: `Add ${track.title} to your queue` }),
    );
    await screen.findByText(`Added "${track.title}" to your queue.`);

    fireEvent.click(screen.getByRole('tab', { name: /QueUp/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add An Archived Track to your queue' }));
    await screen.findByText('Added "An Archived Track" to your queue.');

    const queued = vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([input, init]) => [String(input), init?.body]);
    expect(queued).toEqual([
      [`${API}/api/queue`, JSON.stringify({ url: track.canonicalUrl })],
      [`${API}/api/queue/legacy/archived001`, undefined],
    ]);
  });

  it('narrows a history to a genre somebody clicked, and keeps it in the link', async () => {
    legacyPage = {
      entries: [
        {
          ...play('archived001', 'An Archived Track'),
          genres: {
            entries: [
              {
                source: 'discogs',
                level: 'master',
                genres: ['Rock'],
                styles: ['Indie Rock'],
                url: 'https://www.discogs.com/master/1',
                ambiguous: false,
              },
            ],
            corroborated: false,
            artistLevelOnly: false,
          },
        },
      ],
      total: 1,
    };

    render(<CommunityPage apiUrl={API} view="history" />);
    await openArchive();

    // A style is offered the same way a genre is: the distinction is Discogs'.
    fireEvent.click(screen.getByRole('button', { name: 'Indie Rock' }));

    await waitFor(() => expect(window.location.search).toBe('?tab=queup&genre=Indie+Rock'));
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) =>
        String(input).includes('genre=Indie+Rock'),
      ),
    ).toBe(true);
  });

  it('saves an archived track by its archive id, because it has no media row yet', async () => {
    legacyPage = { entries: [play('archived001', 'An Archived Track')], total: 1 };

    render(<CommunityPage apiUrl={API} view="history" />);
    await openArchive();

    fireEvent.click(screen.getByRole('button', { name: 'Save An Archived Track to a playlist' }));
    fireEvent.click(await screen.findByRole('checkbox'));

    await waitFor(() => {
      const saves = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT');
      expect(saves).toHaveLength(1);
      expect(String(saves[0]![0])).toContain('/legacy/archived001');
    });
  });
});
