import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody, LegacySaveResult, PlaylistLibrary } from '../shared/contracts';

/**
 * What a save is pointed at. Nearly everything the room shows is a row in
 * `media` and can be saved by its id. A play in the QueUp archive is a provider
 * id and nothing else until somebody wants it, so it is saved by the archive's
 * own id and the server resolves the track then.
 */
export type PlaylistSaveTarget =
  | { kind: 'media'; mediaId: string; title: string }
  | { kind: 'legacy'; sourceId: string; title: string };

export interface SaveOutcome {
  playlistId: string;
  /**
   * The media row the target resolved to, so a caller holding an unresolved
   * archive row can stop treating it as one.
   */
  mediaId: string | null;
}

export interface PlaylistLibraryController extends PlaylistLibrary {
  signedIn: boolean | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (name: string, target?: PlaylistSaveTarget) => Promise<SaveOutcome>;
  setMembership: (
    playlistId: string,
    target: PlaylistSaveTarget,
    saved: boolean,
  ) => Promise<SaveOutcome>;
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

  /** The one request that puts a track in a playlist, whichever kind it is. */
  const store = useCallback(
    async (playlistId: string, target: PlaylistSaveTarget): Promise<string> => {
      if (target.kind === 'media') {
        await request(`/api/playlists/${playlistId}/tracks/${target.mediaId}`, 'PUT');
        return target.mediaId;
      }
      const resolved = await request(
        `/api/playlists/${playlistId}/legacy/${encodeURIComponent(target.sourceId)}`,
        'PUT',
      ) as LegacySaveResult;
      return resolved.mediaId;
    },
    [request],
  );

  const create = useCallback(
    async (name: string, target?: PlaylistSaveTarget): Promise<SaveOutcome> => {
      setBusy(true);
      setError(null);
      try {
        const created = await request('/api/playlists', 'POST', { name }) as { id: string };
        const mediaId = target ? await store(created.id, target) : null;
        await refresh();
        return { playlistId: created.id, mediaId };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The playlist could not be created.';
        setError(message);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, request, store],
  );

  const setMembership = useCallback(
    async (
      playlistId: string,
      target: PlaylistSaveTarget,
      saved: boolean,
    ): Promise<SaveOutcome> => {
      setBusy(true);
      setError(null);
      try {
        if (!saved) {
          // Removal is by media id, and an archive row only has one once it has
          // been saved. So nothing can arrive here asking to remove one.
          if (target.kind === 'legacy') {
            throw new Error('That track has to be saved before it can be taken out again.');
          }
          await request(`/api/playlists/${playlistId}/tracks/${target.mediaId}`, 'DELETE');
          await refresh();
          return { playlistId, mediaId: target.mediaId };
        }
        const mediaId = await store(playlistId, target);
        await refresh();
        return { playlistId, mediaId };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The track could not be saved.';
        setError(message);
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, request, store],
  );

  return { ...library, signedIn, loading, busy, error, refresh, create, setMembership };
}
