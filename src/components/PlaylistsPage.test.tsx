// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlaylistDetail,
  PlaylistLibrary,
  PlaylistQueueResult,
  PlaylistSaveResult,
} from '../shared/contracts';
import PlaylistsPage from './PlaylistsPage';

const API = 'http://api.test';

const driving = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Driving',
  trackCount: 2,
  updatedAt: '2026-08-29T12:00:00.000Z',
};

function mediaRow(id: string, title: string) {
  return {
    id,
    provider: 'youtube' as const,
    providerMediaId: id.slice(0, 8),
    canonicalUrl: `https://www.youtube.com/watch?v=${id.slice(0, 8)}`,
    title,
    artist: 'Someone',
    durationSeconds: 200,
    thumbnailUrl: null,
  };
}

const kept = mediaRow('11111111-1111-4111-8111-111111111111', 'I Think About You');
const recent = mediaRow('22222222-2222-4222-8222-222222222222', 'Played An Hour Ago');

const detail: PlaylistDetail = {
  ...driving,
  tracks: [
    { media: kept, position: 0, addedAt: '2026-08-29T12:00:00.000Z' },
    { media: recent, position: 1, addedAt: '2026-08-29T12:01:00.000Z' },
  ],
};

const partialResult: PlaylistQueueResult = {
  attempted: 2,
  added: 1,
  skipped: [
    {
      mediaId: recent.id,
      title: recent.title,
      code: 'TRACK_RECENTLY_PLAYED',
      reason: 'That track played recently. Try again in 42 minutes.',
    },
  ],
};

const library: PlaylistLibrary = {
  playlists: [driving],
  memberships: { [kept.id]: [driving.id], [recent.id]: [driving.id] },
};

const importResult: PlaylistSaveResult = {
  attempted: 5,
  saved: 2,
  duplicates: 2,
  skipped: [{ title: 'A private video', reason: 'That YouTube video is unavailable.' }],
};

let queueCalls = 0;
let savedUrl: string | null = null;
let saveResponse: PlaylistSaveResult = importResult;

function route(url: string, method: string, body?: BodyInit | null) {
  if (url.endsWith('/api/room')) return { status: 200, body: { listenerCount: 0, me: null } };
  if (url.endsWith(`/api/playlists/${driving.id}/tracks`) && method === 'POST') {
    savedUrl = JSON.parse(String(body)).url;
    return { status: 201, body: saveResponse };
  }
  if (url.includes('/api/playlists?') || url.endsWith('/api/playlists')) return { status: 200, body: library };
  if (url.endsWith(`/api/playlists/${driving.id}/queue`) && method === 'POST') {
    queueCalls += 1;
    return { status: 200, body: partialResult };
  }
  if (url.endsWith(`/api/playlists/${driving.id}`)) return { status: 200, body: detail };
  return { status: 200, body: { ok: true } };
}

beforeEach(() => {
  queueCalls = 0;
  savedUrl = null;
  saveResponse = importResult;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const next = route(String(input), init?.method ?? 'GET', init?.body);
      return Promise.resolve({
        ok: next.status < 400,
        status: next.status,
        json: () => Promise.resolve(next.body),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PlaylistsPage', () => {
  it('reports what a whole-playlist queue added and skipped', async () => {
    render(<PlaylistsPage apiUrl={API} />);

    const queueAll = await screen.findByRole('button', { name: /Add playlist to queue/i });
    fireEvent.click(queueAll);

    const summary = await screen.findByText('Added 1 of 2 tracks to your queue.');
    const report = summary.closest('.playlist-report')!;
    expect(report.textContent).toContain(recent.title);
    expect(report.textContent).toContain('Try again in 42 minutes');
    expect(report.textContent).not.toContain(kept.title);
    expect(screen.getByRole('link', { name: 'Open the room' })).toBeDefined();
    expect(queueCalls).toBe(1);
  });

  it('leaves the saved playlist untouched after a partial queue', async () => {
    render(<PlaylistsPage apiUrl={API} />);

    fireEvent.click(await screen.findByRole('button', { name: /Add playlist to queue/i }));
    await waitFor(() => expect(screen.getByText('Added 1 of 2 tracks to your queue.')).toBeDefined());

    const titles = screen.getAllByRole('link').map((node) => node.textContent);
    expect(titles).toContain(kept.title);
    expect(titles).toContain(recent.title);
  });

  it('reports what a pasted provider playlist saved and skipped', async () => {
    render(<PlaylistsPage apiUrl={API} />);

    const box = await screen.findByLabelText('Track or playlist link');
    fireEvent.change(box, { target: { value: 'https://youtube.com/playlist?list=PL123&si=abc' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    const summary = await screen.findByText(`Saved 2 of 5 tracks to "${driving.name}".`);
    const report = summary.closest('.playlist-report')!;
    expect(report.textContent).toContain('2 were already in this playlist.');
    expect(report.textContent).toContain('A private video');
    expect(report.textContent).toContain('That YouTube video is unavailable.');
    expect(savedUrl).toBe('https://youtube.com/playlist?list=PL123&si=abc');
  });

  // A provider playlist holding one track also reports `attempted: 1`, so the
  // outcome decides whether there is anything to explain, not the count.
  it('explains a single track that was skipped instead of claiming it saved', async () => {
    saveResponse = {
      attempted: 1,
      saved: 0,
      duplicates: 0,
      skipped: [{ title: 'A private video', reason: 'That YouTube video is unavailable.' }],
    };
    render(<PlaylistsPage apiUrl={API} />);

    const box = await screen.findByLabelText('Track or playlist link');
    fireEvent.change(box, { target: { value: 'https://youtube.com/playlist?list=PLone' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    const summary = await screen.findByText(`Saved 0 of 1 tracks to "${driving.name}".`);
    expect(summary.closest('.playlist-report')!.textContent).toContain(
      'That YouTube video is unavailable.',
    );
    expect(screen.queryByText(`That track is already in "${driving.name}".`)).toBeNull();
  });

  it('offers sign-in instead of a library when the viewer is signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const signedOut = String(input).includes('/api/playlists');
        return Promise.resolve({
          ok: !signedOut,
          status: signedOut ? 401 : 200,
          json: () => Promise.resolve(signedOut ? { error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } } : { listenerCount: 0, me: null }),
        } as Response);
      }),
    );

    render(<PlaylistsPage apiUrl={API} />);

    await waitFor(() => expect(screen.getByText('Sign in with Destiny to keep private playlists.')).toBeDefined());
    expect(screen.queryByRole('button', { name: /Add playlist to queue/i })).toBeNull();
  });
});
