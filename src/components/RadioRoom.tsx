import {
  ArrowDownToLine,
  ArrowUpToLine,
  Ban,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  ListMusic,
  SkipForward,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  captureClientEvent,
  captureClientException,
  identifyClientUser,
  initClientAnalytics,
  resetClientUser,
} from '../client/analytics';
import { DEFAULT_EMOTE, isPlaylistUrl } from '../shared/contracts';
import { userClass } from './flair';
import type {
  ApiErrorBody,
  PublicRule,
  QueueItem,
  RoomSnapshot,
  RoomUser,
  SearchResult,
} from '../shared/contracts';
import MediaPlayer from './MediaPlayer';
import { moveItem, type MoveDestination } from './reorder';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import SiteHeader, { SiteHeaderAccount, SiteHeaderPresence } from './SiteHeader';
import SiteNav from './SiteNav';
import { usePlaylistLibrary } from './usePlaylistLibrary';
import './RadioRoom.css';

interface RadioRoomProps {
  apiUrl: string;
  posthogKey?: string;
  posthogHost?: string;
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface BlockTarget {
  item: QueueItem;
  /** Set when the block came from the player rather than a queue row. */
  fromPlayer: boolean;
}

interface BlockDialogProps {
  target: BlockTarget;
  rules: PublicRule[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: { ruleIds: string[]; entryType: 'track' | 'artist'; note?: string }) => void;
}

function BlockDialog({ target, rules, busy, onCancel, onConfirm }: BlockDialogProps) {
  const blocklists = rules.filter((rule) => rule.enforcement === 'blocklist');
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [entryType, setEntryType] = useState<'track' | 'artist'>('track');
  const [note, setNote] = useState('');
  const { media } = target.item;

  function toggle(id: string) {
    setRuleIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Block ${media.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Block this request</h2>
        <p className="dialog-subject">
          <strong>{media.title}</strong>
          <span>{media.artist}</span>
        </p>

        <fieldset>
          <legend>What to block</legend>
          <label>
            <input
              type="radio"
              checked={entryType === 'track'}
              onChange={() => setEntryType('track')}
            />
            Just this track
          </label>
          <label>
            <input
              type="radio"
              checked={entryType === 'artist'}
              onChange={() => setEntryType('artist')}
            />
            Everything by {media.artist}
          </label>
        </fieldset>

        <fieldset>
          <legend>Which rules does it break?</legend>
          {blocklists.length === 0 ? (
            <p className="dialog-empty">
              No blocklist rules are switched on. Add one on the admin page first.
            </p>
          ) : (
            blocklists.map((rule) => (
              <label key={rule.id}>
                <input
                  type="checkbox"
                  checked={ruleIds.includes(rule.id)}
                  onChange={() => toggle(rule.id)}
                />
                {rule.name}
              </label>
            ))
          )}
        </fieldset>

        <label className="dialog-note">
          Note (optional)
          <input
            type="text"
            value={note}
            maxLength={240}
            placeholder="Anything the next moderator should know"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <div className="dialog-actions">
          <button type="button" className="dialog-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || ruleIds.length === 0}
            onClick={() => onConfirm({ ruleIds, entryType, note: note.trim() || undefined })}
          >
            Block
          </button>
        </div>
      </div>
    </div>
  );
}

interface PlaylistImport {
  added: number;
  skipped: { title: string; reason: string }[];
}

/** YouTube carries the playlist in `list`, SoundCloud puts `/sets/` in the path. */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function UserAvatar({ user }: { user: RoomUser }) {
  return (
    <span className={userClass(user, 'avatar avatar-frame')} aria-hidden="true">
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" />
      ) : (
        <span className={`emote ${user.topEmote ?? DEFAULT_EMOTE}`} />
      )}
    </span>
  );
}

interface QueueRowProps {
  item: QueueItem;
  index: number;
  canBlock: boolean;
  canRemove: boolean;
  busy: boolean;
  onModerate?: (action: 'remove' | 'block', item: QueueItem) => void;
  onWithdraw?: (item: QueueItem) => void;
  onMove?: (item: QueueItem, destination: MoveDestination) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  canMoveTop?: boolean;
  canMoveBottom?: boolean;
}

function canMoveRoomItem(
  room: RoomSnapshot,
  item: QueueItem,
  index: number,
  destination: MoveDestination,
): boolean {
  const currentRequesterId = room.current?.requestedBy?.id;
  const lockedLastId = room.queue.find(
    ({ requestedBy }) => requestedBy?.id === currentRequesterId,
  )?.id;
  if (item.id === lockedLastId) return false;
  const lastMovableIndex = room.queue.length - (lockedLastId ? 2 : 1);
  return destination === 'up' || destination === 'top'
    ? index > 0
    : index < lastMovableIndex;
}

function QueueRow({
  item,
  index,
  canBlock,
  canRemove,
  busy,
  onModerate,
  onWithdraw,
  onMove,
  canMoveUp,
  canMoveDown,
  canMoveTop,
  canMoveBottom,
}: QueueRowProps) {
  return (
    <li className="queue-row">
      <span className="queue-position">{index + 1}</span>
      {item.media.thumbnailUrl ? (
        <img className="queue-art" src={item.media.thumbnailUrl} alt="" loading="lazy" />
      ) : (
        <span className="queue-art queue-art-empty"><ListMusic size={17} /></span>
      )}
      <div className="queue-copy">
        <a href={item.media.canonicalUrl} target="_blank" rel="noreferrer">
          {item.media.title} <ExternalLink size={12} aria-hidden="true" />
        </a>
        <span>
          {item.media.artist} · {formatDuration(item.media.durationSeconds)}
        </span>
        <span className="requester">
          {item.requestedBy ? (
            <a
              className={userClass(item.requestedBy, 'profile-link')}
              href={`/profile/${encodeURIComponent(item.requestedBy.username)}`}
            >
              {item.requestedBy.username}
            </a>
          ) : (
            <em>requester hidden</em>
          )}
        </span>
      </div>
      <div className="row-controls">
        {onMove && (
          <div className="row-actions row-actions-move">
            <button
              type="button"
              disabled={busy || !canMoveTop}
              onClick={() => onMove(item, 'top')}
              title="Move to top"
              aria-label={`Move ${item.media.title} to the top`}
            >
              <ArrowUpToLine size={15} />
            </button>
            <button
              type="button"
              disabled={busy || !canMoveUp}
              onClick={() => onMove(item, 'up')}
              title="Move up"
              aria-label={`Move ${item.media.title} up`}
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              disabled={busy || !canMoveDown}
              onClick={() => onMove(item, 'down')}
              title="Move down"
              aria-label={`Move ${item.media.title} down`}
            >
              <ChevronDown size={15} />
            </button>
            <button
              type="button"
              disabled={busy || !canMoveBottom}
              onClick={() => onMove(item, 'bottom')}
              title="Move to bottom"
              aria-label={`Move ${item.media.title} to the bottom`}
            >
              <ArrowDownToLine size={15} />
            </button>
          </div>
        )}
        {(canRemove || canBlock) && onModerate && (
          <div className="row-actions">
            {canRemove && (
              <button
                type="button"
                aria-label={`Remove ${item.media.title}`}
                title="Remove from queue"
                disabled={busy}
                onClick={() => onModerate('remove', item)}
              >
                <Trash2 size={15} />
              </button>
            )}
            {canBlock && (
              <button
                type="button"
                aria-label={`Block ${item.media.title}`}
                title="Block this track"
                disabled={busy}
                onClick={() => onModerate('block', item)}
              >
                <Ban size={15} />
              </button>
            )}
          </div>
        )}
        {onWithdraw && (
          <div className="row-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onWithdraw(item)}
              title="Take this out of your queue"
              aria-label={`Take ${item.media.title} out of your queue`}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default function RadioRoom({ apiUrl, posthogKey, posthogHost }: RadioRoomProps) {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestUrl, setRequestUrl] = useState('');
  const [mode, setMode] = useState<'link' | 'search'>('link');
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [importReport, setImportReport] = useState<PlaylistImport | null>(null);
  const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const identifiedUserId = useRef<string | null>(null);
  const capturedConnection = useRef(false);
  const playlistLibrary = usePlaylistLibrary(
    apiUrl,
    room?.current ? [room.current.media.id] : [],
    Boolean(room?.me),
  );

  useEffect(() => {
    initClientAnalytics(posthogKey, posthogHost);
  }, [posthogHost, posthogKey]);

  useEffect(() => {
    if (!room) return;
    if (room.me && identifiedUserId.current !== room.me.id) {
      identifyClientUser(room.me.id, { role: room.me.role, team: room.me.team });
      identifiedUserId.current = room.me.id;
    } else if (!room.me && identifiedUserId.current) {
      resetClientUser();
      identifiedUserId.current = null;
    }
  }, [room?.me]);

  const apiRequest = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${apiUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorBody = body as ApiErrorBody | null;
        throw new ApiRequestError(
          errorBody?.error?.message ?? 'The radio server rejected the request.',
          response.status,
        );
      }
      return body as T;
    },
    [apiUrl],
  );

  const refreshRoom = useCallback(async () => {
    try {
      const snapshot = await apiRequest<RoomSnapshot>('/api/room');
      setRoom(snapshot);
      setNotice(null);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status >= 500) {
        captureClientException(error, { area: 'room_snapshot', status: error.status });
      }
      setNotice(error instanceof Error ? error.message : 'The room could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [apiRequest]);

  useEffect(() => {
    void refreshRoom();
    const fallbackPoll = window.setInterval(() => void refreshRoom(), 15_000);
    return () => window.clearInterval(fallbackPoll);
  }, [refreshRoom]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    const wsUrl = new URL(apiUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.pathname = '/ws';

    const connect = () => {
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        setConnected(true);
        if (!capturedConnection.current) {
          captureClientEvent('radio_session_connected');
          capturedConnection.current = true;
        }
      };
      socket.onmessage = () => void refreshRoom();
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) reconnectTimer.current = window.setTimeout(connect, 2_000);
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [apiUrl, refreshRoom]);

  /** Returns the response body on success and null on failure, so callers can read it. */
  const mutate = async <T,>(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    try {
      const payload = await apiRequest<T>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await refreshRoom();
      return payload;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status >= 500) {
        captureClientException(error, { area: 'api_mutation', path, status: error.status });
      }
      setNotice(error instanceof Error ? error.message : 'The request failed.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = requestUrl.trim();
    if (!url) return;

    // One box for both: a playlist link takes the bulk path on its own.
    if (isPlaylistUrl(url)) {
      const imported = await mutate<PlaylistImport>('/api/queue/playlist', 'POST', { url });
      if (imported) {
        setRequestUrl('');
        setImportReport(imported);
      }
      return;
    }
    if (await mutate('/api/queue', 'POST', { url })) setRequestUrl('');
  };

  const addSearchResult = async (result: SearchResult) => {
    if (await mutate('/api/queue', 'POST', { url: result.url })) {
      setResults((current) => current.filter((entry) => entry.url !== result.url));
    }
  };

  const runSearch = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) return;
    setSearching(true);
    try {
      const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Search failed.');
      setResults(payload.results);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Search failed.');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const vote = async (value: -1 | 1) => {
    if (!room?.current) return;
    const nextValue = room.current.myVote === value ? 0 : value;
    await mutate(`/api/queue/${room.current.id}/vote`, 'POST', { value: nextValue });
  };

  const askReason = (action: string): string | null => {
    const reason = window.prompt(`${action}. Give a short reason:`)?.trim();
    if (!reason) return null;
    if (reason.length < 3) {
      setNotice('The moderation reason must be at least three characters.');
      return null;
    }
    return reason;
  };

  const moveMyTrack = useCallback(
    async (item: QueueItem, destination: MoveDestination) => {
      const orderedIds = moveItem(room?.myQueue ?? [], item.id, destination);
      if (orderedIds) await mutate('/api/queue/order', 'PATCH', { orderedIds });
    },
    [room?.myQueue, mutate],
  );

  const moveRoomTrack = useCallback(
    async (item: QueueItem, destination: MoveDestination) => {
      const currentRequesterId = room?.current?.requestedBy?.id;
      const lockedLastId = room?.queue.find(
        ({ requestedBy }) => requestedBy?.id === currentRequesterId,
      )?.id;
      const orderedIds = moveItem(room?.queue ?? [], item.id, destination, lockedLastId);
      if (orderedIds) await mutate('/api/queue/room-order', 'PATCH', { orderedIds });
    },
    [room?.current?.requestedBy?.id, room?.queue, mutate],
  );

  const withdrawMyTrack = async (item: QueueItem) => {
    await mutate(`/api/queue/${item.id}`, 'DELETE');
  };

  const moderateQueueItem = async (action: 'remove' | 'block', item: QueueItem) => {
    if (action === 'block') {
      setBlockTarget({ item, fromPlayer: false });
      return;
    }
    const reason = askReason(`Remove ${item.media.title}`);
    if (!reason) return;
    await mutate(`/api/queue/${item.id}/remove`, 'POST', { reason });
  };

  const confirmBlock = async (choice: {
    ruleIds: string[];
    entryType: 'track' | 'artist';
    note?: string;
  }) => {
    if (!blockTarget) return;
    const { item } = blockTarget;
    setBlockTarget(null);
    await mutate(`/api/queue/${item.id}/block`, 'POST', choice);
  };

  const skip = async () => {
    const reason = askReason('Skip the current track');
    if (reason) await mutate('/api/current/skip', 'POST', { reason });
  };

  const blockCurrent = () => {
    if (!room?.current) return;
    setBlockTarget({ item: room.current, fromPlayer: true });
  };

  const logout = async () => {
    if (await mutate('/api/auth/logout', 'POST')) await refreshRoom();
  };

  const admin = room?.me?.role === 'admin';
  const moderator = admin || room?.me?.role === 'mod';

  return (
    <div className="radio-app">
      <SiteHeader>
        <SiteHeaderPresence connected={connected} listenerCount={room?.listenerCount ?? 0} />
        <SiteHeaderAccount apiUrl={apiUrl} me={room?.me ?? null} busy={busy} onLogout={() => void logout()} />
      </SiteHeader>

      <SiteNav active="room" />

      {notice && <div className="notice" role="alert">{notice}</div>}

      <main className="room-layout" aria-busy={loading}>
        <div className="main-column">
          <MediaPlayer
            current={room?.current ?? null}
            serverTime={room?.serverTime ?? null}
            onListeningStarted={(provider) => captureClientEvent('listening_started', { provider })}
            onPlayerError={(message, provider, errorCode) =>
              captureClientException(new Error(message), {
                area: 'media_player',
                provider,
                error_code: errorCode,
              })
            }
          />

          <section className="now-controls">
            <div className="vote-group" aria-label="Vote on the current track">
              <button
                className={room?.current?.myVote === 1 ? 'vote-active vote-up' : ''}
                type="button"
                disabled={!room?.me || !room.current || busy}
                onClick={() => void vote(1)}
              >
                <ThumbsUp size={17} /> {room?.current?.upvotes ?? 0}
              </button>
              <button
                className={room?.current?.myVote === -1 ? 'vote-active vote-down' : ''}
                type="button"
                disabled={!room?.me || !room.current || busy}
                onClick={() => void vote(-1)}
              >
                <ThumbsDown size={17} /> {room?.current?.downvotes ?? 0}
              </button>
              {!room?.me && <span>Sign in to vote</span>}
            </div>
            {room?.me && room.current && (
              <SaveToPlaylistButton
                key={room.current.media.id}
                media={room.current.media}
                library={playlistLibrary}
              />
            )}
            {moderator && room?.current && (
              <div className="admin-actions">
                <button type="button" disabled={busy} onClick={blockCurrent}>
                  <Ban size={16} /> Block
                </button>
                <button type="button" disabled={busy} onClick={() => void skip()}>
                  <SkipForward size={16} /> Skip
                </button>
              </div>
            )}
          </section>

          <section className="request-section">
            <h2>Request a track</h2>
            <div className="request-modes" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'link'}
                className={mode === 'link' ? 'mode-active' : ''}
                onClick={() => setMode('link')}
              >
                Paste a link
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'search'}
                className={mode === 'search' ? 'mode-active' : ''}
                onClick={() => setMode('search')}
              >
                Search YouTube + SoundCloud
              </button>
            </div>

            {mode === 'link' ? (
              <>
                <form className="request-form" onSubmit={(event) => void submitRequest(event)}>
                  <label htmlFor="track-url">Track or playlist URL</label>
                  <div>
                    <input
                      id="track-url"
                      type="url"
                      placeholder="https://www.youtube.com/watch?v=..."
                      value={requestUrl}
                      disabled={!room?.me || busy}
                      onChange={(event) => setRequestUrl(event.target.value)}
                    />
                    <button type="submit" disabled={!room?.me || !requestUrl.trim() || busy}>
                      {isPlaylistUrl(requestUrl.trim()) ? 'Import playlist' : 'Add to queue'}
                    </button>
                  </div>
                </form>
                <p>
                  A playlist or set link adds up to 50 of its tracks to your queue. Requests are
                  checked for availability in {room?.settings.targetCountry ?? 'the playback region'},
                  embedding, age restriction, and the length limit first.
                </p>
              </>
            ) : (
              <>
                <form className="request-form" onSubmit={(event) => void runSearch(event)}>
                  <label htmlFor="track-search">Search YouTube or SoundCloud by title or artist</label>
                  <div>
                    <input
                      id="track-search"
                      type="search"
                      placeholder="Boards of Canada"
                      value={searchQuery}
                      disabled={!room?.me || busy}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    <button
                      type="submit"
                      disabled={!room?.me || searchQuery.trim().length < 2 || busy}
                    >
                      {searching ? 'Searching...' : 'Search'}
                    </button>
                  </div>
                </form>
                {results.length > 0 && (
                  <ul className="search-results">
                    {results.map((result) => (
                      <li key={result.url}>
                        {result.thumbnailUrl ? (
                          <img src={result.thumbnailUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="search-art-empty">
                            <ListMusic size={16} />
                          </span>
                        )}
                        <div className="search-copy">
                          <strong>{result.title}</strong>
                          <span>
                            <span className={`search-provider search-provider-${result.provider}`}>
                              {result.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}
                            </span>{' '}
                            ·{' '}
                            {result.artist} · {formatDuration(result.durationSeconds)}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void addSearchResult(result)}
                        >
                          Add
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  Search YouTube and SoundCloud. Every result is checked before it joins your queue.
                </p>
              </>
            )}

            {blockTarget && (
        <BlockDialog
          target={blockTarget}
          rules={room?.rules ?? []}
          busy={busy}
          onCancel={() => setBlockTarget(null)}
          onConfirm={(choice) => void confirmBlock(choice)}
        />
      )}

      {importReport && (
              <div className="import-report">
                <p>
                  Added {importReport.added} track{importReport.added === 1 ? '' : 's'}.
                  {importReport.skipped.length > 0 && ` Skipped ${importReport.skipped.length}.`}
                </p>
                {importReport.skipped.length > 0 && (
                  <ul>
                    {importReport.skipped.slice(0, 8).map((item) => (
                      <li key={item.title}>
                        <strong>{item.title}</strong> - {item.reason}
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" onClick={() => setImportReport(null)}>
                  Dismiss
                </button>
              </div>
            )}
          </section>

          <section className="stats-section">
            <div className="section-heading">
              <h2>Top Jammers</h2>
              <span>Votes received on played tracks</span>
            </div>
            {room?.selectorStats.length ? (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr><th>Jammer</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {room.selectorStats.map((entry, index) => (
                      <tr key={entry.user.id}>
                        <td>
                          <span className="rank">{index + 1}</span>
                          <UserAvatar user={entry.user} />
                          <a
                            className={userClass(entry.user, 'profile-link')}
                            href={`/profile/${encodeURIComponent(entry.user.username)}`}
                          >
                            {entry.user.username}
                          </a>
                        </td>
                        <td>{entry.plays}</td>
                        <td>{entry.upvotes}</td>
                        <td>{entry.downvotes}</td>
                        <td className={entry.score > 0 ? 'positive-score' : entry.score < 0 ? 'negative-score' : ''}>
                          {entry.score > 0 ? '+' : ''}{entry.score}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-copy">Scores appear after the first track receives votes.</p>
            )}
          </section>

          <details className="rules-section">
            <summary>Room rules <ChevronDown size={16} /></summary>
            <div className="rules-content">
              {room?.rules.length ? (
                <ol className="rule-list">
                  {room.rules.map((rule) => (
                    <li key={rule.id}>
                      <strong>{rule.name}</strong>
                      {rule.description && <p>{rule.description}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No rules are switched on right now.</p>
              )}
            </div>
          </details>

          {room?.settings.description && (
            <details className="rules-section" open>
              <summary>
                About this room <ChevronDown size={16} />
              </summary>
              <div className="rules-content">
                {room.settings.description
                  .split(/\n{2,}/)
                  .map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
              </div>
            </details>
          )}
        </div>

        <aside className="queue-column">
          <div className="queue-heading">
            <div>
              <h2>Up next</h2>
              <span>{room?.queue.length ?? 0} waiting · one turn each</span>
            </div>
            <Clock3 size={18} />
          </div>
          {room?.queue.length ? (
            <ol className="queue-list">
              {room.queue.map((item, index) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  index={index}
                  canBlock={moderator}
                  canRemove={admin}
                  busy={busy}
                  onModerate={(action, selected) => void moderateQueueItem(action, selected)}
                  onMove={moderator ? (selected, destination) => void moveRoomTrack(selected, destination) : undefined}
                  canMoveUp={moderator && canMoveRoomItem(room, item, index, 'up')}
                  canMoveDown={moderator && canMoveRoomItem(room, item, index, 'down')}
                  canMoveTop={moderator && canMoveRoomItem(room, item, index, 'top')}
                  canMoveBottom={moderator && canMoveRoomItem(room, item, index, 'bottom')}
                />
              ))}
            </ol>
          ) : (
            <div className="queue-empty">
              <ListMusic size={26} />
              <p>No requests waiting.</p>
              <span>Each person gets one turn before their next track plays.</span>
            </div>
          )}

          {room?.me && (
            <>
              <div className="queue-heading queue-heading-mine">
                <div>
                  <h2>Your queue</h2>
                  <span>
                    {room.myQueue.length
                      ? `${room.myQueue.length} waiting · the top one plays on your turn`
                      : 'Nothing queued'}
                  </span>
                </div>
                <ListMusic size={18} />
              </div>
              {room.myQueue.length > 0 && (
                <ol className="queue-list">
                  {room.myQueue.map((item, index) => (
                    <QueueRow
                      key={item.id}
                      item={item}
                      index={index}
                      canBlock={false}
                      canRemove={false}
                      busy={busy}
                      onWithdraw={(selected) => void withdrawMyTrack(selected)}
                      onMove={(selected, destination) => void moveMyTrack(selected, destination)}
                      canMoveUp={index > 0}
                      canMoveDown={index < room.myQueue.length - 1}
                      canMoveTop={index > 0}
                      canMoveBottom={index < room.myQueue.length - 1}
                    />
                  ))}
                </ol>
              )}
            </>
          )}

          <div className="identity-note">
            <UserRound size={17} />
            <p>Requests and votes stay attached to your Destiny account, even if you later change your username.</p>
          </div>
        </aside>
      </main>

      <footer className="room-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
