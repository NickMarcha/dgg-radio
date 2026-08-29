import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody, PlaylistLibrary } from '../shared/contracts';

export interface PlaylistLibraryController extends PlaylistLibrary {
  signedIn: boolean | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string, mediaId?: string) => Promise<string>;
  setMembership: (playlistId: string, mediaId: string, saved: boolean) => Promise<void>;
}

export function usePlaylistLibrary(
  apiUrl: string,
  mediaIds: string[],
  enabled = true,
): PlaylistLibraryController {
  const mediaKey = [...new Set(mediaIds)].sort().join(',');
  const [library, setLibrary] = useState<PlaylistLibrary>({ playlists: [], memberships: {} });
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = (payload as ApiErrorBody | null)?.error.message ?? 'The playlist request failed.';
        throw Object.assign(new Error(message), { status: response.status });
      }
      return payload;
    },
    [apiUrl],
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setSignedIn(null);
      setLibrary({ playlists: [], memberships: {} });
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = mediaKey ? `?mediaIds=${encodeURIComponent(mediaKey)}` : '';
      const payload = await request(`/api/playlists${query}`) as PlaylistLibrary;
      setLibrary(payload);
      setSignedIn(true);
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 401) {
        setSignedIn(false);
        setLibrary({ playlists: [], memberships: {} });
      } else {
        setError(cause instanceof Error ? cause.message : 'The playlist request failed.');
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, mediaKey, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string, mediaId?: string) => {
      setBusy(true);
      setError(null);
      try {
        const created = await request('/api/playlists', 'POST', { name }) as { id: string };
        if (mediaId) {
          await request(`/api/playlists/${created.id}/tracks/${mediaId}`, 'PUT');
        }
        await refresh();
        return created.id;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The playlist could not be created.';
        setError(message);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, request],
  );

  const setMembership = useCallback(
    async (playlistId: string, mediaId: string, saved: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await request(
          `/api/playlists/${playlistId}/tracks/${mediaId}`,
          saved ? 'PUT' : 'DELETE',
        );
        await refresh();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The track could not be saved.';
        setError(message);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, request],
  );

  return { ...library, signedIn, loading, busy, error, refresh, create, setMembership };
}
