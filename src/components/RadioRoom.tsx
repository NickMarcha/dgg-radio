import {
  Ban,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  Headphones,
  ListMusic,
  LogIn,
  LogOut,
  Radio,
  Shield,
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
import type { ApiErrorBody, QueueItem, RoomSnapshot, RoomUser } from '../shared/contracts';
import MediaPlayer from './MediaPlayer';
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

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function userInitial(user: RoomUser): string {
  return user.username.slice(0, 1).toUpperCase();
}

function TeamLabel({ user }: { user: RoomUser }) {
  if (!user.team) return null;
  return <span className={`team-label team-${user.team}`}>{user.team.toUpperCase()}</span>;
}

function UserAvatar({ user }: { user: RoomUser }) {
  return (
    <span className="avatar" aria-hidden="true">
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : userInitial(user)}
    </span>
  );
}

interface QueueRowProps {
  item: QueueItem;
  index: number;
  admin: boolean;
  busy: boolean;
  onModerate: (action: 'remove' | 'block', item: QueueItem) => void;
  onMove?: (item: QueueItem, direction: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

function QueueRow({
  item,
  index,
  admin,
  busy,
  onModerate,
  onMove,
  canMoveUp,
  canMoveDown,
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
            <>
              {item.requestedBy.username} <TeamLabel user={item.requestedBy} />
            </>
          ) : (
            <em>requester hidden</em>
          )}
        </span>
      </div>
      {onMove && (
        <div className="row-actions">
          <button
            type="button"
            disabled={busy || !canMoveUp}
            onClick={() => onMove(item, -1)}
            title="Move up"
            aria-label={`Move ${item.media.title} up`}
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            disabled={busy || !canMoveDown}
            onClick={() => onMove(item, 1)}
            title="Move down"
            aria-label={`Move ${item.media.title} down`}
          >
            <ChevronDown size={15} />
          </button>
        </div>
      )}
      {admin && (
        <div className="row-actions">
          <button
            type="button"
            aria-label={`Remove ${item.media.title}`}
            title="Remove from queue"
            disabled={busy}
            onClick={() => onModerate('remove', item)}
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            aria-label={`Block ${item.media.title}`}
            title="Block this track"
            disabled={busy}
            onClick={() => onModerate('block', item)}
          >
            <Ban size={15} />
          </button>
        </div>
      )}
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
  const [maxMinutes, setMaxMinutes] = useState('7');
  const reconnectTimer = useRef<number | undefined>(undefined);
  const identifiedUserId = useRef<string | null>(null);
  const capturedConnection = useRef(false);

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
      setMaxMinutes(String(snapshot.settings.maxDurationSeconds / 60));
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

  const mutate = async (path: string, method: 'POST' | 'PATCH', body?: unknown) => {
    setBusy(true);
    setNotice(null);
    try {
      await apiRequest(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await refreshRoom();
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status >= 500) {
        captureClientException(error, { area: 'api_mutation', path, status: error.status });
      }
      setNotice(error instanceof Error ? error.message : 'The request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitRequest = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!requestUrl.trim()) return;
    if (await mutate('/api/queue', 'POST', { url: requestUrl.trim() })) setRequestUrl('');
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
    async (item: QueueItem, direction: -1 | 1) => {
      const current = room?.myQueue ?? [];
      const from = current.findIndex(({ id }) => id === item.id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= current.length) return;
      const ordered = current.map(({ id }) => id);
      [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
      await mutate('/api/queue/order', 'PATCH', { orderedIds: ordered });
    },
    [room?.myQueue, mutate],
  );

  const moderateQueueItem = async (action: 'remove' | 'block', item: QueueItem) => {
    const reason = askReason(action === 'block' ? `Block ${item.media.title}` : `Remove ${item.media.title}`);
    if (!reason) return;
    await mutate(`/api/queue/${item.id}/${action}`, 'POST', { reason });
  };

  const skip = async () => {
    const reason = askReason('Skip the current track');
    if (reason) await mutate('/api/current/skip', 'POST', { reason });
  };

  const blockCurrent = async () => {
    if (!room?.current) return;
    const reason = askReason(`Block ${room.current.media.title}`);
    if (reason) await mutate(`/api/queue/${room.current.id}/block`, 'POST', { reason });
  };

  const saveSettings = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const seconds = Math.round(Number(maxMinutes) * 60);
    await mutate('/api/settings', 'PATCH', { maxDurationSeconds: seconds });
  };

  const logout = async () => {
    if (await mutate('/api/auth/logout', 'POST')) await refreshRoom();
  };

  const admin = room?.me?.role === 'admin';

  return (
    <div className="radio-app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DGG Radio home">
          <Radio size={22} />
          <span>DGG Radio</span>
          <span className="beta-badge">beta</span>
        </a>
        <div className="room-presence">
          <span className={connected ? 'connection-ok' : 'connection-wait'}>
            {connected ? 'Connected' : 'Reconnecting'}
          </span>
          <span><Headphones size={15} /> {room?.listenerCount ?? 0}</span>
        </div>
        <div className="account">
          {room?.me ? (
            <>
              <UserAvatar user={room.me} />
              <span className="account-name">
                {room.me.username} <TeamLabel user={room.me} />
              </span>
              {admin && <span className="admin-label"><Shield size={13} /> mod</span>}
              <button className="text-button" type="button" onClick={() => void logout()} disabled={busy}>
                <LogOut size={15} /> Sign out
              </button>
            </>
          ) : (
            <button
              className="login-button"
              type="button"
              onClick={() => { window.location.href = `${apiUrl}/api/auth/login`; }}
            >
              <LogIn size={16} /> Sign in with Destiny
            </button>
          )}
        </div>
      </header>

      {notice && <div className="notice" role="alert">{notice}</div>}

      <main className="room-layout" aria-busy={loading}>
        <div className="main-column">
          <MediaPlayer current={room?.current ?? null} serverTime={room?.serverTime ?? null} />

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
            {admin && room?.current && (
              <div className="admin-actions">
                <button type="button" disabled={busy} onClick={() => void blockCurrent()}>
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
            <form className="request-form" onSubmit={(event) => void submitRequest(event)}>
              <label htmlFor="track-url">YouTube or SoundCloud URL</label>
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
                  Add to queue
                </button>
              </div>
            </form>
            <p>
              YouTube requests are checked for UAE availability, embedding, age restriction, and the {room ? Math.floor(room.settings.maxDurationSeconds / 60) : 7}-minute limit before they enter the queue.
            </p>
          </section>

          <section className="stats-section">
            <div className="section-heading">
              <h2>Top selectors</h2>
              <span>Votes received on played tracks</span>
            </div>
            {room?.selectorStats.length ? (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr><th>Selector</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {room.selectorStats.map((entry, index) => (
                      <tr key={entry.user.id}>
                        <td>
                          <span className="rank">{index + 1}</span>
                          <UserAvatar user={entry.user} />
                          {entry.user.username}
                          <TeamLabel user={entry.user} />
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
                  admin={admin}
                  busy={busy}
                  onModerate={(action, selected) => void moderateQueueItem(action, selected)}
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
                      admin={false}
                      busy={busy}
                      onModerate={(action, selected) => void moderateQueueItem(action, selected)}
                      onMove={(selected, direction) => void moveMyTrack(selected, direction)}
                      canMoveUp={index > 0}
                      canMoveDown={index < room.myQueue.length - 1}
                    />
                  ))}
                </ol>
              )}
            </>
          )}

          {admin && (
            <form className="room-settings" onSubmit={(event) => void saveSettings(event)}>
              <div><Shield size={16} /><h3>Room settings</h3></div>
              <label htmlFor="max-minutes">Maximum track length in minutes</label>
              <div>
                <input
                  id="max-minutes"
                  type="number"
                  min="1"
                  max="30"
                  step="0.5"
                  value={maxMinutes}
                  onChange={(event) => setMaxMinutes(event.target.value)}
                />
                <button type="submit" disabled={busy}>Save</button>
              </div>
            </form>
          )}

          <div className="identity-note">
            <UserRound size={17} />
            <p>Requests and votes stay attached to your Destiny account, even if you later change your username.</p>
          </div>
        </aside>
      </main>
    </div>
  );
}
