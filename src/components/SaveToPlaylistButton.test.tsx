// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistLibrary, RoomMedia } from '../shared/contracts';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import { usePlaylistLibrary, type PlaylistLibraryController } from './usePlaylistLibrary';

const API = 'http://api.test';

const track: RoomMedia = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'youtube',
  providerMediaId: 'abc123',
  canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
  title: 'I Think About You',
  artist: 'Someone',
  durationSeconds: 212,
  thumbnailUrl: null,
};

const second: RoomMedia = { ...track, id: '22222222-2222-4222-8222-222222222222', title: 'Another' };

const driving = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Driving', trackCount: 3, updatedAt: '2026-08-29T12:00:00.000Z' };
const memeNight = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Meme night', trackCount: 0, updatedAt: '2026-08-29T12:00:00.000Z' };

/** Every response the fake API hands back, in call order, keyed by nothing else. */
const responses: Array<{ status: number; body: unknown }> = [];
let calls: Array<{ url: string; method: string }> = [];

function library(payload: PlaylistLibrary, status = 200) {
  responses.push({ status, body: payload });
}

function fetchMock(input: RequestInfo | URL, init?: RequestInit) {
  calls.push({ url: String(input), method: init?.method ?? 'GET' });
  const next = responses.shift() ?? { status: 200, body: { ok: true } };
  return Promise.resolve({
    ok: next.status < 400,
    status: next.status,
    json: () => Promise.resolve(next.body),
  } as Response);
}

/** Renders the button with a real hook so state changes follow the API responses. */
function Harness({ media = track, mediaIds = [track.id] }: { media?: RoomMedia; mediaIds?: string[] }) {
  const controller: PlaylistLibraryController = usePlaylistLibrary(API, mediaIds);
  if (!controller.signedIn) return <p>signed out</p>;
  return <SaveToPlaylistButton media={media} library={controller} />;
}

beforeEach(() => {
  responses.length = 0;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(fetchMock));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPicker() {
  await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await screen.findByRole('dialog');
}

function checkbox(name: string): HTMLInputElement {
  const label = screen.getAllByText(name).find((node) => node.closest('label'));
  return label!.closest('label')!.querySelector('input')!;
}

function toggle(name: string) {
  fireEvent.click(checkbox(name));
}

describe('SaveToPlaylistButton', () => {
  it('hides the save action for a signed-out viewer', async () => {
    library({ playlists: [], memberships: {} }, 401);

    render(<Harness />);

    await waitFor(() => expect(screen.getByText('signed out')).toBeDefined());
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('shows the playlists the track is already in', async () => {
    library({ playlists: [driving, memeNight], memberships: { [track.id]: [driving.id] } });

    render(<Harness />);
    await openPicker();

    expect(checkbox('Driving').checked).toBe(true);
    expect(checkbox('Meme night').checked).toBe(false);
  });

  it('saves the track and marks the playlist', async () => {
    library({ playlists: [driving, memeNight], memberships: { [track.id]: [] } });
    responses.push({ status: 200, body: { ok: true } });
    library({ playlists: [driving, memeNight], memberships: { [track.id]: [memeNight.id] } });

    render(<Harness />);
    await openPicker();
    toggle('Meme night');

    await waitFor(() => expect(checkbox('Meme night').checked).toBe(true));
    expect(calls.some(({ url, method }) => method === 'PUT' && url === `${API}/api/playlists/${memeNight.id}/tracks/${track.id}`)).toBe(true);
  });

  it('removes the track when the box is cleared', async () => {
    library({ playlists: [driving], memberships: { [track.id]: [driving.id] } });
    responses.push({ status: 200, body: { ok: true } });
    library({ playlists: [driving], memberships: { [track.id]: [] } });

    render(<Harness />);
    await openPicker();
    toggle('Driving');

    await waitFor(() => expect(checkbox('Driving').checked).toBe(false));
    expect(calls.some(({ url, method }) => method === 'DELETE' && url === `${API}/api/playlists/${driving.id}/tracks/${track.id}`)).toBe(true);
  });

  it('keeps the previous membership when the API refuses the change', async () => {
    library({ playlists: [driving], memberships: { [track.id]: [driving.id] } });
    responses.push({ status: 500, body: { error: { code: 'INTERNAL', message: 'That playlist is full.' } } });

    render(<Harness />);
    await openPicker();
    toggle('Driving');

    await waitFor(() => expect(screen.getByText('That playlist is full.')).toBeDefined());
    expect(checkbox('Driving').checked).toBe(true);
  });

  it('asks for every displayed track in one request', async () => {
    library({ playlists: [driving], memberships: { [track.id]: [driving.id], [second.id]: [] } });

    render(<Harness mediaIds={[track.id, second.id, track.id]} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeDefined());
    const listCalls = calls.filter(({ url }) => url.startsWith(`${API}/api/playlists?`));
    expect(listCalls).toHaveLength(1);
    expect(decodeURIComponent(listCalls[0]!.url)).toContain([track.id, second.id].sort().join(','));
  });
});
