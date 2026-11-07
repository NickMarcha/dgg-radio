import {
  ArrowDownToLine,
  ArrowUpToLine,
  Ban,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  ListMusic,
  Settings,
  SkipForward,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
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
  QueueMovePlan,
  StationSnapshot,
  StationUser,
  SearchResult,
} from '../shared/contracts';
import MediaPlayer from './MediaPlayer';
import { moveItem, type MoveDestination } from './reorder';
import { createStationSocketUrl, getStationVisitorId } from './stationSocket';
import { rememberStation, stationSlugFromPath } from '../client/station';
import { MAIN_STATION_SLUG } from '../shared/stationConnection';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import SiteHeader, { SiteHeaderAccount, SiteHeaderPresence } from './SiteHeader';
import SiteNav from './SiteNav';
import { usePlaylistLibrary } from './usePlaylistLibrary';
import './RadioStation.css';

interface RadioStationProps {
  apiUrl: string;
  posthogKey?: string;
  posthogHost?: string;
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
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

function UserAvatar({ user }: { user: StationUser }) {
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

function canMoveStationItem(
  station: StationSnapshot,
  item: QueueItem,
  index: number,
  destination: MoveDestination,
): boolean {
  const currentRequesterId = station.current?.requestedBy?.id;
  const lockedLastId = station.queue.find(
    ({ requestedBy }) => requestedBy?.id === currentRequesterId,
  )?.id;
  if (item.id === lockedLastId) return false;
  const lastMovableIndex = station.queue.length - (lockedLastId ? 2 : 1);
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

export default function RadioStation({ apiUrl, posthogKey, posthogHost }: RadioStationProps) {
  // One generated page serves every station, so the station is read from the address.
  const [stationSlug] = useState(() =>
    typeof window === 'undefined' ? MAIN_STATION_SLUG : stationSlugFromPath(window.location.pathname),
  );
  const stationApi = `/api/stations/${stationSlug}`;
  const [station, setStation] = useState<StationSnapshot | null>(null);
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
    station?.current ? [station.current.media.id] : [],
    Boolean(station?.me),
  );

  useEffect(() => {
    initClientAnalytics(posthogKey, posthogHost);
  }, [posthogHost, posthogKey]);

  // Only a station that answered is worth sending a later request to.
  const loadedSlug = station?.station.slug;
  useEffect(() => {
    if (loadedSlug) rememberStation(loadedSlug);
  }, [loadedSlug]);

  useEffect(() => {
    if (!station) return;
    if (station.me && identifiedUserId.current !== station.me.id) {
      identifyClientUser(station.me.id, { role: station.me.role, team: station.me.team });
      identifiedUserId.current = station.me.id;
    } else if (!station.me && identifiedUserId.current) {
      resetClientUser();
      identifiedUserId.current = null;
    }
  }, [station?.me]);

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
          errorBody?.error?.code ?? null,
        );
      }
      return body as T;
    },
    [apiUrl],
  );

  const refreshRoom = useCallback(async () => {
    try {
      const snapshot = await apiRequest<StationSnapshot>(stationApi);
      setStation(snapshot);
      setNotice(null);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status >= 500) {
        captureClientException(error, { area: 'station_snapshot', status: error.status });
      }
      setNotice(error instanceof Error ? error.message : 'The station could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [apiRequest, stationApi]);

  useEffect(() => {
    void refreshRoom();
    const fallbackPoll = window.setInterval(() => void refreshRoom(), 15_000);
    return () => window.clearInterval(fallbackPoll);
  }, [refreshRoom]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    const wsUrl = createStationSocketUrl(apiUrl, {
      kind: 'station',
      station: stationSlug,
      visitorId: getStationVisitorId(),
    });

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
      socket.onclose = (event) => {
        setConnected(false);
        // 4404: the station does not exist, which retrying will not change.
        if (!stopped && event.code !== 4404) {
          reconnectTimer.current = window.setTimeout(connect, 2_000);
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [apiUrl, refreshRoom, stationSlug]);

  /**
   * Someone queued in another station is asked whether to bring their queue here,
   * with what this station would leave behind. Answers whether it moved.
   */
  const offerQueueMove = async (): Promise<boolean> => {
    const plan = await apiRequest<QueueMovePlan>(`${stationApi}/queue/move`);
    if (!plan.from) return false;
    const coming = plan.tracks.filter((track) => track.refused === null).length;
    const leaving = plan.tracks.filter((track) => track.refused !== null);
    const lines = [
      `You have ${plan.tracks.length} track${plan.tracks.length === 1 ? '' : 's'} waiting in ${plan.from.name}.`,
      `Move your queue here? ${coming} will come along and you will leave the rotation there.`,
      ...(leaving.length > 0
        ? ['', 'This station will not take:', ...leaving.map((track) => `• ${track.title}: ${track.refused}`)]
        : []),
    ];
    if (!window.confirm(lines.join('\n'))) return false;
    await apiRequest(`${stationApi}/queue/move`, { method: 'POST' });
    return true;
  };

  /** Returns the response body on success and null on failure, so callers can read it. */
  const mutate = async <T,>(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
  ): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    const send = () =>
      apiRequest<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      let payload: T;
      try {
        payload = await send();
      } catch (error) {
        // A listener queues in one station; asking here is how they change which.
        if (!(error instanceof ApiRequestError && error.code === 'QUEUED_ELSEWHERE')) throw error;
        if (!(await offerQueueMove())) {
          setNotice(error.message);
          return null;
        }
        payload = await send();
      }
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
      const imported = await mutate<PlaylistImport>(`${stationApi}/queue/playlist`, 'POST', { url });
      if (imported) {
        setRequestUrl('');
        setImportReport(imported);
      }
      return;
    }
    if (await mutate(`${stationApi}/queue`, 'POST', { url })) setRequestUrl('');
  };

  const addSearchResult = async (result: SearchResult) => {
    if (await mutate(`${stationApi}/queue`, 'POST', { url: result.url })) {
      setResults((current) => current.filter((entry) => entry.url !== result.url));
    }
  };

  const runSearch = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2) return;
    setSearching(true);
    let status: number | null = null;
    try {
      const response = await fetch(`${apiUrl}/api/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
      });
      status = response.status;
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Search failed.');
      setResults(payload.results);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Search failed.');
      // An answer the station meant to give -- a rate limit, a query it rejected --
      // is not a fault worth a trace. A provider that failed or an API that
      // could not be reached is, and the query rides along because a replay
      // masks what people type and the search box is the one field that
      // explains the error.
      if (status === null || status >= 500) {
        captureClientException(error, { area: 'search', query, status });
      }
      setNotice(error.message);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const vote = async (value: -1 | 1) => {
    if (!station?.current) return;
    const nextValue = station.current.myVote === value ? 0 : value;
    await mutate(`/api/queue/${station.current.id}/vote`, 'POST', { value: nextValue });
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
      const orderedIds = moveItem(station?.myQueue ?? [], item.id, destination);
      if (orderedIds) await mutate('/api/queue/order', 'PATCH', { orderedIds });
    },
    [station?.myQueue, mutate],
  );

  const moveStationTrack = useCallback(
    async (item: QueueItem, destination: MoveDestination) => {
      const currentRequesterId = station?.current?.requestedBy?.id;
      const lockedLastId = station?.queue.find(
        ({ requestedBy }) => requestedBy?.id === currentRequesterId,
      )?.id;
      const orderedIds = moveItem(station?.queue ?? [], item.id, destination, lockedLastId);
      if (orderedIds) await mutate(`${stationApi}/queue/station-order`, 'PATCH', { orderedIds });
    },
    [station?.current?.requestedBy?.id, station?.queue, mutate],
  );

  const withdrawMyTrack = async (item: QueueItem) => {
    await mutate(`/api/queue/${item.id}`, 'DELETE');
  };

  const dismissNotice = async (queueItemId: string) => {
    await mutate(`/api/queue/${queueItemId}/notice`, 'DELETE');
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
    if (reason) await mutate(`${stationApi}/current/skip`, 'POST', { reason });
  };

  const blockCurrent = () => {
    if (!station?.current) return;
    setBlockTarget({ item: station.current, fromPlayer: true });
  };

  const logout = async () => {
    if (await mutate('/api/auth/logout', 'POST')) await refreshRoom();
  };

  // Site admins come back as owners, so this is the station's own answer.
  const owner = station?.myStationRole === 'owner';
  const moderator = owner || station?.myStationRole === 'mod';

  return (
    <div className="radio-app">
      <SiteHeader>
        <SiteHeaderPresence connected={connected} listenerCount={station?.listenerCount ?? 0} />
        <SiteHeaderAccount apiUrl={apiUrl} me={station?.me ?? null} busy={busy} onLogout={() => void logout()} />
      </SiteHeader>

      <SiteNav active="station" />

      {station && station.station.slug !== MAIN_STATION_SLUG && (
        <div className="station-name">
          <h1>{station.station.name}</h1>
          {owner && (
            <a href={`/admin?station=${encodeURIComponent(station.station.slug)}`}>
              <Settings size={14} /> Manage
            </a>
          )}
        </div>
      )}

      {notice && <div className="notice" role="alert">{notice}</div>}

      <main className="station-layout" aria-busy={loading}>
        <div className="main-column">
          <MediaPlayer
            current={station?.current ?? null}
            genres={station?.currentGenres ?? null}
            serverTime={station?.serverTime ?? null}
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
                className={station?.current?.myVote === 1 ? 'vote-active vote-up' : ''}
                type="button"
                disabled={!station?.me || !station.current || busy}
                onClick={() => void vote(1)}
              >
                <ThumbsUp size={17} /> {station?.current?.upvotes ?? 0}
              </button>
              <button
                className={station?.current?.myVote === -1 ? 'vote-active vote-down' : ''}
                type="button"
                disabled={!station?.me || !station.current || busy}
                onClick={() => void vote(-1)}
              >
                <ThumbsDown size={17} /> {station?.current?.downvotes ?? 0}
              </button>
              {!station?.me && <span>Sign in to vote</span>}
            </div>
            {station?.me && station.current && (
              <SaveToPlaylistButton
                key={station.current.media.id}
                target={{
                  kind: 'media',
                  mediaId: station.current.media.id,
                  title: station.current.media.title,
                }}
                library={playlistLibrary}
              />
            )}
            {moderator && station?.current && (
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
                      disabled={!station?.me || busy}
                      onChange={(event) => setRequestUrl(event.target.value)}
                    />
                    <button type="submit" disabled={!station?.me || !requestUrl.trim() || busy}>
                      {isPlaylistUrl(requestUrl.trim()) ? 'Import playlist' : 'Add to queue'}
                    </button>
                  </div>
                </form>
                <p>
                  A playlist or set link adds up to 50 of its tracks to your queue. Requests are
                  checked for availability in {station?.settings.targetCountry ?? 'the playback region'},
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
                      disabled={!station?.me || busy}
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    <button
                      type="submit"
                      disabled={!station?.me || searchQuery.trim().length < 2 || busy}
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
          rules={station?.rules ?? []}
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
            {station?.selectorStats.length ? (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr><th>Jammer</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {station.selectorStats.map((entry, index) => (
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
            <summary>Station rules <ChevronDown size={16} /></summary>
            <div className="rules-content">
              {station?.rules.length ? (
                <ol className="rule-list">
                  {station.rules.map((rule) => (
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

          {station?.settings.description && (
            <details className="rules-section" open>
              <summary>
                About this station <ChevronDown size={16} />
              </summary>
              <div className="rules-content">
                {station.settings.description
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
              <span>{station?.queue.length ?? 0} waiting · one turn each</span>
            </div>
            <Clock3 size={18} />
          </div>
          {station?.queue.length ? (
            <ol className="queue-list">
              {station.queue.map((item, index) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  index={index}
                  canBlock={moderator}
                  canRemove={owner}
                  busy={busy}
                  onModerate={(action, selected) => void moderateQueueItem(action, selected)}
                  onMove={moderator ? (selected, destination) => void moveStationTrack(selected, destination) : undefined}
                  canMoveUp={moderator && canMoveStationItem(station, item, index, 'up')}
                  canMoveDown={moderator && canMoveStationItem(station, item, index, 'down')}
                  canMoveTop={moderator && canMoveStationItem(station, item, index, 'top')}
                  canMoveBottom={moderator && canMoveStationItem(station, item, index, 'bottom')}
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

          {station?.me && (
            <>
              {station.myNotices.length > 0 && (
                <>
                  <div className="queue-heading queue-heading-mine">
                    <div>
                      <h2>Dropped from your queue</h2>
                      <span>The station could not play these when your turn came</span>
                    </div>
                    <TriangleAlert size={18} />
                  </div>
                  <ul className="queue-notices">
                    {station.myNotices.map((entry) => (
                      <li key={entry.queueItemId}>
                        <div>
                          <strong>{entry.title}</strong>
                          <span>{entry.artist}</span>
                          <p>{entry.message}</p>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Dismiss the notice about ${entry.title}`}
                          onClick={() => void dismissNotice(entry.queueItemId)}
                        >
                          <X size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="queue-heading queue-heading-mine">
                <div>
                  <h2>Your queue</h2>
                  <span>
                    {station.myQueue.length
                      ? `${station.myQueue.length} waiting · the top one plays on your turn`
                      : 'Nothing queued'}
                  </span>
                </div>
                <ListMusic size={18} />
              </div>
              {station.myQueue.length > 0 && (
                <ol className="queue-list">
                  {station.myQueue.map((item, index) => (
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
                      canMoveDown={index < station.myQueue.length - 1}
                      canMoveTop={index > 0}
                      canMoveBottom={index < station.myQueue.length - 1}
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

      <footer className="station-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
