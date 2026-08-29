import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  ListMusic,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type {
  ApiErrorBody,
  PlaylistDetail,
  PlaylistQueueResult,
  PlaylistSaveResult,
  SearchResult,
} from '../shared/contracts';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import { usePlaylistLibrary } from './usePlaylistLibrary';
import './PlaylistsPage.css';

interface PlaylistsPageProps {
  apiUrl: string;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export default function PlaylistsPage({ apiUrl }: PlaylistsPageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<PlaylistQueueResult | null>(null);
  const [saveResult, setSaveResult] = useState<PlaylistSaveResult | null>(null);
  const [trackUrl, setTrackUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const library = usePlaylistLibrary(
    apiUrl,
    detail?.tracks.map(({ media }) => media.id) ?? [],
  );

  const call = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((payload as ApiErrorBody | null)?.error.message ?? 'The request failed.');
      }
      return payload as T;
    },
    [apiUrl],
  );

  const refreshDetail = useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const next = await call<PlaylistDetail>(`/api/playlists/${selectedId}`);
    setDetail(next);
  }, [call, selectedId]);

  useEffect(() => {
    if (library.playlists.length === 0) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    if (!selectedId || !library.playlists.some(({ id }) => id === selectedId)) {
      setSelectedId(library.playlists[0]!.id);
    }
  }, [library.playlists, selectedId]);

  useEffect(() => {
    setQueueResult(null);
    setSaveResult(null);
    void refreshDetail().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'The playlist could not be loaded.');
    });
  }, [refreshDetail]);

  async function act(work: () => Promise<void>, success?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (success) setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void act(async () => {
      const id = await library.create(trimmed);
      setName('');
      setSelectedId(id);
    }, `Created "${trimmed}".`);
  }

  function rename() {
    if (!detail) return;
    const nextName = window.prompt('Rename playlist', detail.name)?.trim();
    if (!nextName || nextName === detail.name) return;
    void act(async () => {
      await call(`/api/playlists/${detail.id}`, 'PATCH', { name: nextName });
      await Promise.all([library.refresh(), refreshDetail()]);
    }, `Renamed playlist to "${nextName}".`);
  }

  function removePlaylist() {
    if (!detail || !window.confirm(`Delete "${detail.name}"? The tracks will stay in radio history.`)) {
      return;
    }
    void act(async () => {
      await call(`/api/playlists/${detail.id}`, 'DELETE');
      setSelectedId(null);
      setDetail(null);
      await library.refresh();
    }, `Deleted "${detail.name}".`);
  }

  function removeTrack(mediaId: string) {
    if (!detail) return;
    void act(async () => {
      await call(`/api/playlists/${detail.id}/tracks/${mediaId}`, 'DELETE');
      await Promise.all([library.refresh(), refreshDetail()]);
    });
  }

  function addByUrl(event: SubmitEvent) {
    event.preventDefault();
    const url = trackUrl.trim();
    if (!url || !detail) return;
    void act(async () => {
      const result = await call<PlaylistSaveResult>(
        `/api/playlists/${detail.id}/tracks`,
        'POST',
        { url },
      );
      setTrackUrl('');
      // One track that plainly landed needs no report. Anything else -- a whole
      // provider playlist, or a single track that was skipped -- has to explain
      // itself, so report on the outcome rather than on how many were tried.
      const plain = result.attempted === 1 && result.skipped.length === 0;
      setSaveResult(plain ? null : result);
      if (plain) {
        setNotice(
          result.saved === 1
            ? `Added the track to "${detail.name}".`
            : `That track is already in "${detail.name}".`,
        );
      }
      await Promise.all([library.refresh(), refreshDetail()]);
    });
  }

  function addResult(result: SearchResult) {
    if (!detail) return;
    void act(async () => {
      await call(`/api/playlists/${detail.id}/tracks`, 'POST', { url: result.url });
      setResults((current) => current.filter((entry) => entry.url !== result.url));
      await Promise.all([library.refresh(), refreshDetail()]);
    }, `Added "${result.title}".`);
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) return;
    void act(async () => {
      setSearching(true);
      try {
        const payload = await call<{ results: SearchResult[] }>(
          `/api/search?q=${encodeURIComponent(query)}`,
        );
        setResults(payload.results);
      } finally {
        setSearching(false);
      }
    });
  }

  function queueTrack(mediaId: string) {
    if (!detail) return;
    void act(async () => {
      await call(`/api/playlists/${detail.id}/tracks/${mediaId}/queue`, 'POST');
    }, 'Added the track to your queue.');
  }

  function queueAll() {
    if (!detail) return;
    void act(async () => {
      const result = await call<PlaylistQueueResult>(`/api/playlists/${detail.id}/queue`, 'POST');
      setQueueResult(result);
    });
  }

  function moveTrack(mediaId: string, destination: 'top' | 'up' | 'down' | 'bottom') {
    if (!detail) return;
    const orderedMediaIds = detail.tracks.map(({ media }) => media.id);
    const from = orderedMediaIds.indexOf(mediaId);
    if (from < 0) return;
    const to = destination === 'top'
      ? 0
      : destination === 'bottom'
        ? orderedMediaIds.length - 1
        : destination === 'up'
          ? from - 1
          : from + 1;
    if (to < 0 || to >= orderedMediaIds.length || to === from) return;
    const [moved] = orderedMediaIds.splice(from, 1);
    orderedMediaIds.splice(to, 0, moved!);
    void act(async () => {
      await call(`/api/playlists/${detail.id}/tracks/order`, 'PATCH', { orderedMediaIds });
      await refreshDetail();
    });
  }

  return (
    <div className="playlists-app">
      <SiteHeader apiUrl={apiUrl} />
      <SiteNav active="playlists" />
      <main className="playlists-main">
        {library.signedIn === false ? (
          <section className="playlists-signed-out">
            <h1>Playlists</h1>
            <p>Sign in with Destiny to keep private playlists.</p>
            <a href={`${apiUrl}/api/auth/login`}>Sign in</a>
          </section>
        ) : (
          <>
            <header className="playlists-heading">
              <h1>Playlists</h1>
              <form onSubmit={(event) => create(event)}>
                <input
                  value={name}
                  maxLength={80}
                  placeholder="New playlist name"
                  aria-label="New playlist name"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
                <button type="submit" disabled={busy || library.busy || !name.trim()}>
                  <Plus size={16} /> Create
                </button>
              </form>
            </header>

            {(error || library.error) && <p className="playlists-error">{error ?? library.error}</p>}
            {notice && <p className="playlists-notice">{notice}</p>}

            {library.loading && library.playlists.length === 0 ? (
              <p className="playlists-loading">Loading playlists...</p>
            ) : (
              <div className="playlists-layout">
                <aside className="playlist-index" aria-label="Your playlists">
                  {library.playlists.length === 0 ? (
                    <p>Create your first playlist above.</p>
                  ) : (
                    <ul>
                      {library.playlists.map((playlist) => (
                        <li key={playlist.id}>
                          <button
                            type="button"
                            className={selectedId === playlist.id ? 'is-selected' : ''}
                            onClick={() => setSelectedId(playlist.id)}
                          >
                            <span>{playlist.name}</span>
                            <small>{playlist.trackCount}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </aside>

                <section className="playlist-detail">
                  {detail ? (
                    <>
                      <header>
                        <div>
                          <h2>{detail.name}</h2>
                          <span>{detail.trackCount} track{detail.trackCount === 1 ? '' : 's'}</span>
                        </div>
                        <div className="playlist-detail-actions">
                          <button type="button" disabled={busy || detail.tracks.length === 0} onClick={queueAll}>
                            <Play size={15} /> Add playlist to queue
                          </button>
                          <button type="button" disabled={busy} onClick={rename} title="Rename playlist">
                            <Pencil size={15} />
                          </button>
                          <button type="button" disabled={busy} onClick={removePlaylist} title="Delete playlist">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </header>

                      {queueResult && (
                        <div className="playlist-report">
                          <p>Added {queueResult.added} of {queueResult.attempted} tracks to your queue.</p>
                          {queueResult.skipped.length > 0 && (
                            <ul>
                              {queueResult.skipped.map((item) => (
                                <li key={item.mediaId}><strong>{item.title}</strong> {item.reason}</li>
                              ))}
                            </ul>
                          )}
                          {queueResult.added > 0 && <a href="/player">Open the room</a>}
                        </div>
                      )}

                      {saveResult && (
                        <div className="playlist-report">
                          <p>Saved {saveResult.saved} of {saveResult.attempted} tracks to "{detail.name}".</p>
                          {saveResult.duplicates > 0 && (
                            <p>
                              {saveResult.duplicates} {saveResult.duplicates === 1 ? 'was' : 'were'} already in this playlist.
                            </p>
                          )}
                          {saveResult.skipped.length > 0 && (
                            <ul>
                              {saveResult.skipped.map((item, index) => (
                                <li key={index}><strong>{item.title}</strong> {item.reason}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      <div className="playlist-add">
                        <form onSubmit={(event) => addByUrl(event)}>
                          <input
                            value={trackUrl}
                            placeholder="Paste a track or playlist link"
                            aria-label="Track or playlist link"
                            onChange={(event) => setTrackUrl(event.currentTarget.value)}
                          />
                          <button type="submit" disabled={busy || !trackUrl.trim()}>
                            <Plus size={15} /> Add
                          </button>
                        </form>
                        <form onSubmit={(event) => search(event)}>
                          <input
                            value={searchQuery}
                            placeholder="Search YouTube and SoundCloud"
                            aria-label="Search for a track"
                            onChange={(event) => setSearchQuery(event.currentTarget.value)}
                          />
                          <button type="submit" disabled={busy || searchQuery.trim().length < 2}>
                            <Search size={15} /> {searching ? 'Searching' : 'Search'}
                          </button>
                        </form>
                      </div>

                      {results.length > 0 && (
                        <ul className="playlist-search-results">
                          {results.map((result) => (
                            <li key={result.url}>
                              {result.thumbnailUrl ? (
                                <img src={result.thumbnailUrl} alt="" loading="lazy" />
                              ) : (
                                <span className="playlist-art-empty"><ListMusic size={16} /></span>
                              )}
                              <div className="playlist-track-copy">
                                <a href={result.url} target="_blank" rel="noreferrer">{result.title}</a>
                                <span>
                                  {result.provider === 'youtube' ? 'YouTube' : 'SoundCloud'} · {result.artist} · {formatDuration(result.durationSeconds)}
                                </span>
                              </div>
                              <div className="playlist-track-actions">
                                <button type="button" disabled={busy} onClick={() => addResult(result)} title={`Add ${result.title} to ${detail.name}`}>
                                  <Plus size={15} />
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}

                      {detail.tracks.length === 0 ? (
                        <p className="playlist-empty">Save a playing track or a track from history to fill this playlist.</p>
                      ) : (
                        <ol className="playlist-track-list">
                          {detail.tracks.map((track, index) => (
                            <li key={track.media.id}>
                              {track.media.thumbnailUrl ? (
                                <img src={track.media.thumbnailUrl} alt="" loading="lazy" />
                              ) : (
                                <span className="playlist-art-empty"><ListMusic size={16} /></span>
                              )}
                              <div className="playlist-track-copy">
                                <a href={track.media.canonicalUrl} target="_blank" rel="noreferrer">
                                  {track.media.title}
                                </a>
                                <span>{track.media.artist} · {formatDuration(track.media.durationSeconds)}</span>
                              </div>
                              <div className="playlist-track-move">
                                <button type="button" disabled={busy || index === 0} onClick={() => moveTrack(track.media.id, 'top')} title="Move to top"><ArrowUpToLine size={14} /></button>
                                <button type="button" disabled={busy || index === 0} onClick={() => moveTrack(track.media.id, 'up')} title="Move up"><ChevronUp size={14} /></button>
                                <button type="button" disabled={busy || index === detail.tracks.length - 1} onClick={() => moveTrack(track.media.id, 'down')} title="Move down"><ChevronDown size={14} /></button>
                                <button type="button" disabled={busy || index === detail.tracks.length - 1} onClick={() => moveTrack(track.media.id, 'bottom')} title="Move to bottom"><ArrowDownToLine size={14} /></button>
                              </div>
                              <div className="playlist-track-actions">
                                <button type="button" disabled={busy} onClick={() => queueTrack(track.media.id)} title="Add to queue"><Play size={15} /></button>
                                <SaveToPlaylistButton media={track.media} library={library} compact onChanged={refreshDetail} />
                                <button type="button" disabled={busy} onClick={() => removeTrack(track.media.id)} title="Remove from playlist"><Trash2 size={15} /></button>
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </>
                  ) : (
                    <p className="playlist-empty">Select a playlist.</p>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </main>
      <footer className="playlists-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
