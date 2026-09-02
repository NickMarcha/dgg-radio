import {
  Activity,
  ArrowDownToLine,
  ArrowUpToLine,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  ListMusic,
  Loader2,
  MonitorPlay,
  ScrollText,
  Shield,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type {
  RoomMember,
  RoomSnapshot,
  RuleEntrySummary,
  RuleSummary,
  PlaybackRegion,
  ModerationEntry,
  ModerationLog,
  OperationsSnapshot,
  SearchResult,
  UserRole,
} from '../shared/contracts';
import { moveItem, type MoveDestination } from './reorder';
import './AdminPanel.css';

interface AdminPanelProps {
  apiUrl: string;
}

type Settings = RoomSnapshot['settings'];

const REGION_HINT = 'The country the YouTube availability checks run against.';

const TABS = [
  { id: 'room', label: 'Room', icon: SlidersHorizontal },
  { id: 'people', label: 'People', icon: Users },
  { id: 'log', label: 'Log', icon: ScrollText },
  { id: 'server', label: 'Server', icon: Activity },
  { id: 'obs', label: 'OBS', icon: MonitorPlay },
] as const;

export type AdminTab = (typeof TABS)[number]['id'];

/** The open tab lives in the URL hash, so a reload or a shared link reopens it. */
export function tabFromHash(hash: string): AdminTab {
  const id = hash.replace(/^#/, '');
  return TABS.some((tab) => tab.id === id) ? (id as AdminTab) : 'room';
}

type CooldownUnit = 'minutes' | 'hours' | 'days';

const COOLDOWN_UNIT_SECONDS: Record<CooldownUnit, number> = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};

export function cooldownParts(seconds: number): { amount: number; unit: CooldownUnit } {
  if (seconds % COOLDOWN_UNIT_SECONDS.days === 0) {
    return { amount: seconds / COOLDOWN_UNIT_SECONDS.days, unit: 'days' };
  }
  if (seconds % COOLDOWN_UNIT_SECONDS.hours === 0) {
    return { amount: seconds / COOLDOWN_UNIT_SECONDS.hours, unit: 'hours' };
  }
  return { amount: seconds / COOLDOWN_UNIT_SECONDS.minutes, unit: 'minutes' };
}

export function cooldownSeconds(amount: number, unit: CooldownUnit): number {
  return Math.round(amount * COOLDOWN_UNIT_SECONDS[unit]);
}

const BYTE_UNITS = ['bytes', 'kB', 'MB', 'GB', 'TB'] as const;

/** PostgreSQL's own 1024-based units, so the figures match `pg_size_pretty`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${value} ${value === 1 ? 'byte' : 'bytes'}`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

export function formatShare(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent.toFixed(1)}%`;
}

export function elapsedTime(from: string, to: string): string {
  const seconds = Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;

  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

export default function AdminPanel({ apiUrl }: AdminPanelProps) {
  const [me, setMe] = useState<RoomSnapshot['me']>(null);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [regions, setRegions] = useState<PlaybackRegion[]>([]);
  const [operations, setOperations] = useState<OperationsSnapshot | null>(null);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const [moderation, setModeration] = useState<ModerationLog | null>(null);
  const [moderationBusy, setModerationBusy] = useState(false);
  const [tab, setTab] = useState<AdminTab>('room');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? 'That request did not go through.');
      }
      return payload;
    },
    [apiUrl],
  );

  const refresh = useCallback(async () => {
    const room: RoomSnapshot = await call('/api/room');
    setMe(room.me);
    setSettings(room.settings);
    if (room.me?.role !== 'admin') return;
    const [ruleList, memberList] = await Promise.all([
      call('/api/rules'),
      call(`/api/users${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    ]);
    setRules(ruleList.rules);
    setMembers(memberList.users);
  }, [call, search]);

  const refreshOperations = useCallback(async () => {
    setOperationsBusy(true);
    try {
      setOperations(await call('/api/operations'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Server activity could not be loaded.');
    } finally {
      setOperationsBusy(false);
    }
  }, [call]);

  useEffect(() => {
    void refresh()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoaded(true));
  }, [refresh]);

  // A region list YouTube would not hand over leaves the field as free text
  // rather than blocking the rest of the panel.
  useEffect(() => {
    if (me?.role !== 'admin') return;
    void call('/api/regions')
      .then((payload) => setRegions(payload.regions))
      .catch(() => setRegions([]));
  }, [call, me?.role]);

  // The pages are prerendered, so the hash is only readable once this runs in a
  // browser.
  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // The snapshot is fetched when the Server tab first opens, so the other tabs
  // never pay for it.
  useEffect(() => {
    if (me?.role === 'admin' && tab === 'server' && !operations) void refreshOperations();
  }, [me?.role, tab, operations, refreshOperations]);

  const refreshModeration = useCallback(async () => {
    setModerationBusy(true);
    try {
      setModeration(await call('/api/moderation'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The moderation log could not be loaded.');
    } finally {
      setModerationBusy(false);
    }
  }, [call]);

  useEffect(() => {
    if (me?.role === 'admin' && tab === 'log' && !moderation) void refreshModeration();
  }, [me?.role, tab, moderation, refreshModeration]);

  const act = useCallback(
    async (work: () => Promise<unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        await refresh();
        setNotice(message);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Something went wrong.');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (!loaded) {
    return (
      <main className="admin admin-centred">
        <Loader2 className="spin" size={22} /> <span>Loading the admin panel…</span>
      </main>
    );
  }

  if (!me) {
    return (
      <main className="admin admin-centred">
        <p>Sign in with Destiny to reach the admin panel.</p>
        <a className="admin-link" href={`${apiUrl}/api/auth/login`}>
          Sign in
        </a>
      </main>
    );
  }

  if (me.role !== 'admin') {
    return (
      <main className="admin admin-centred">
        <p>Only admins can access this page.</p>
        <a className="admin-link" href="/player">
          Back to the room
        </a>
      </main>
    );
  }

  return (
    <main className="admin">
      <header className="admin-header">
        <div>
          <h1>Room admin</h1>
          <p>Signed in as {me.username}</p>
        </div>
        <div className="admin-header-links">
          <a
            className="admin-link"
            href="https://github.com/NickMarcha/dgg-radio"
            target="_blank"
            rel="noreferrer"
          >
            Source on GitHub <ExternalLink size={13} />
          </a>
          <a className="admin-link" href="/player">
            Back to the room
          </a>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={id === tab ? 'admin-tab admin-tab-open' : 'admin-tab'}
            aria-current={id === tab ? 'page' : undefined}
            onClick={() => {
              window.location.hash = id;
              setTab(id);
            }}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-notice">{notice}</p>}

      {tab === 'room' && settings && (
        <SettingsSection settings={settings} regions={regions} busy={busy} act={act} call={call} />
      )}
      {tab === 'room' && <RulesSection rules={rules} busy={busy} act={act} call={call} />}

      {tab === 'people' && (
        <PeopleSection
          members={members}
          search={search}
          onSearch={setSearch}
          busy={busy}
          act={act}
          call={call}
        />
      )}

      {tab === 'log' && (
        <ModerationSection
          log={moderation}
          busy={moderationBusy}
          onRefresh={() => void refreshModeration()}
        />
      )}

      {tab === 'server' && (
        <>
          <OperationsSection
            snapshot={operations}
            busy={operationsBusy}
            onRefresh={() => void refreshOperations()}
          />
          <ExportsSection apiUrl={apiUrl} />
        </>
      )}

      {tab === 'obs' && <ObsSources />}
    </main>
  );
}

/** What can be taken out of the room, and what is in each of them. */
const EXPORT_GROUPS = [
  {
    title: 'What the room holds',
    datasets: [
      {
        id: 'history',
        label: 'Room history',
        description: 'Every track this room has played or skipped, with who requested it and its votes.',
      },
      {
        id: 'archive',
        label: 'QueUp archive',
        description: 'The plays imported from QueUp, as they were imported.',
      },
      {
        id: 'tracks',
        label: 'Track catalogue',
        description: 'Every track the room has a row for, with what each source says it is.',
      },
      {
        id: 'lookups',
        label: 'Provider cache',
        description: 'What YouTube and SoundCloud last said about each track, including refusals.',
      },
    ],
  },
  {
    title: 'Stats, in full rather than the page\u2019s top of each',
    datasets: [
      {
        id: 'stats-tracks',
        label: 'Tracks',
        description: 'Every track by plays and votes, not only the hundred the stats page shows.',
      },
      {
        id: 'stats-jammers',
        label: 'Jammers',
        description: 'Every listener by plays and the votes their requests drew.',
      },
      {
        id: 'stats-genres',
        label: 'Genres',
        description: 'Every genre by plays, this room and the QueUp archive counted apart.',
      },
    ],
  },
] as const;

/**
 * Copies of the room's data, as CSV.
 *
 * Plain links rather than buttons that fetch: the browser is being asked to
 * save a file, and a top-level navigation carries the session cookie and hands
 * the download to the browser without any of it passing through here. The
 * archive is the big one, tens of thousands of rows, so it is worth saying that
 * it takes a moment rather than looking broken while it does.
 */
function ExportsSection({ apiUrl }: { apiUrl: string }) {
  return (
    <section className="admin-card">
      <div className="admin-section-heading">
        <h2>
          <Download size={18} /> Export data
        </h2>
      </div>
      <p className="admin-export-note">
        A copy of what the room knows, as CSV. Everything but the provider cache opens in a
        spreadsheet as it is; the cache keeps each provider's stored answer as JSON in its own
        column. A large export takes a few seconds to build before the download starts.
      </p>
      {EXPORT_GROUPS.map((group) => (
        <div key={group.title} className="admin-export-group">
          <h3>{group.title}</h3>
          <ul className="admin-exports">
            {group.datasets.map((dataset) => (
              <li key={dataset.id}>
                <a href={`${apiUrl}/api/exports/${dataset.id}`}>
                  <Download size={14} /> {dataset.label}
                </a>
                <span>{dataset.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function RulesSection({ rules, busy, act, call }: SectionProps & { rules: RuleSummary[] }) {
  const [entries, setEntries] = useState<Record<string, RuleEntrySummary[]>>({});

  function moveRule(rule: RuleSummary, destination: MoveDestination) {
    const orderedIds = moveItem(rules, rule.id, destination);
    if (!orderedIds) return;
    void act(() => call('/api/rules/order', 'PATCH', { orderedIds }), `Moved "${rule.name}".`);
  }

  async function toggleEntries(ruleId: string) {
    if (entries[ruleId]) {
      setEntries(({ [ruleId]: _removed, ...rest }) => rest);
      return;
    }
    const payload = await call(`/api/rules/${ruleId}/entries`);
    setEntries((current) => ({ ...current, [ruleId]: payload.entries }));
  }

  return (
    <section className="admin-card">
      <h2>
        <Ban size={18} /> Rules
      </h2>
      <p className="admin-help">
        A blocklist rule collects the tracks and artists that broke it, so blocking a song under it
        teaches the room. An advisory rule is only shown to listeners. Switching a rule off hides it
        from the player and stops it being enforced, but keeps its list for later.
      </p>

      <NewRuleForm busy={busy} act={act} call={call} />

      {rules.length === 0 ? (
        <p className="admin-empty">No rules yet.</p>
      ) : (
        <ul className="admin-list">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              busy={busy}
              act={act}
              call={call}
              entries={entries[rule.id]}
              index={index}
              total={rules.length}
              onMove={(destination) => moveRule(rule, destination)}
              onToggleEntries={() => void toggleEntries(rule.id)}
              onEntryRemoved={() =>
                setEntries(({ [rule.id]: _removed, ...rest }) => rest)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PeopleSection({
  members,
  search,
  onSearch,
  busy,
  act,
  call,
}: SectionProps & { members: RoomMember[]; search: string; onSearch: (value: string) => void }) {
  return (
    <section className="admin-card">
      <h2>
        <Users size={18} /> People
      </h2>
      <input
        type="search"
        value={search}
        placeholder="Search by username"
        onChange={(event) => onSearch(event.currentTarget.value)}
        aria-label="Search people"
      />
      <ul className="admin-list">
        {members.map((member) => (
          <li key={member.id}>
            <div className="admin-row">
              <div>
                <strong>{member.username}</strong>
                {member.role !== 'listener' && (
                  <span className="admin-meta">
                    <Shield size={13} /> {member.isRoot ? 'root admin' : member.role}
                  </span>
                )}
                {member.queuedCount > 0 && (
                  <span className="admin-meta">
                    <ListMusic size={13} /> {member.queuedCount} queued
                  </span>
                )}
              </div>
              <div className="admin-row-actions">
                {member.queuedCount > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt(`Clear ${member.username}'s queue. Reason?`);
                      if (reason) {
                        void act(
                          () => call(`/api/users/${member.id}/clear-queue`, 'POST', { reason }),
                          `Cleared ${member.username}'s queue.`,
                        );
                      }
                    }}
                  >
                    Clear queue
                  </button>
                )}
                <select
                  aria-label={`Role for ${member.username}`}
                  value={member.role}
                  disabled={busy || member.isRoot}
                  title={member.isRoot ? 'Root admins are set in the environment' : undefined}
                  onChange={(event) => {
                    const role = event.currentTarget.value as UserRole;
                    void act(
                      () => call(`/api/users/${member.id}/role`, 'PATCH', { role }),
                      `${member.username} is now ${role === 'listener' ? 'a listener' : `a ${role}`}.`,
                    );
                  }}
                >
                  <option value="listener">Listener</option>
                  <option value="mod">Mod</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
          </li>
        ))}
        {members.length === 0 && <li className="admin-empty">Nobody matches that.</li>}
      </ul>
    </section>
  );
}

/**
 * Everything the room writes to the log. An action it does not know is still
 * shown, spelled as it was stored, because a log that hides what it cannot
 * caption is worse than one that reads awkwardly.
 */
const MODERATION_VERBS: Record<string, string> = {
  skip: 'skipped',
  remove: 'removed',
  block_track: 'blocked the track',
  block_artist: 'blocked the artist',
  clear_queue: 'cleared the queue of',
  reorder_room_queue: 'reordered the room queue',
  update_settings: 'changed room settings',
};

/** The parts of a record worth reading when it carries no reason of its own. */
export function moderationSummary(entry: ModerationEntry): string | null {
  if (entry.action === 'update_settings') {
    const changed = Object.keys(entry.details);
    return changed.length ? `Changed ${changed.join(', ')}.` : null;
  }
  if (entry.action === 'clear_queue') {
    const removed = entry.details.removed;
    return typeof removed === 'number'
      ? `${removed} ${removed === 1 ? 'track' : 'tracks'} dropped.`
      : null;
  }
  if (entry.action === 'reorder_room_queue') {
    const order = entry.details.orderedIds;
    return Array.isArray(order) ? `${order.length} tracks put in a new order.` : null;
  }
  return null;
}

function ModerationSection({
  log,
  busy,
  onRefresh,
}: {
  log: ModerationLog | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="admin-card">
      <div className="admin-section-heading">
        <h2>
          <ScrollText size={18} /> Moderation log
        </h2>
        <button className="admin-refresh" type="button" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={busy ? 'spin' : undefined} size={14} /> Refresh
        </button>
      </div>
      <p className="admin-help">
        Every skip, removal, block, cleared queue and settings change the room has recorded, newest
        first. It is written as each action happens and nothing here can be edited.
      </p>

      {!log ? (
        <p className="admin-empty">Loading the moderation log…</p>
      ) : log.entries.length === 0 ? (
        <p className="admin-empty">Nothing has been moderated yet.</p>
      ) : (
        <ul className="admin-log-list">
          {log.entries.map((entry) => {
            const summary = moderationSummary(entry);
            return (
              <li key={entry.id}>
                <div className="admin-log-head">
                  <p>
                    <strong>{entry.actor}</strong> {MODERATION_VERBS[entry.action] ?? entry.action}
                    {entry.target && <> <strong>{entry.target}</strong></>}
                    {entry.track && (
                      <>
                        {' '}
                        <span className="admin-log-track">
                          {entry.track.title}
                          {entry.track.artist && ` · ${entry.track.artist}`}
                        </span>
                      </>
                    )}
                  </p>
                  <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
                    {elapsedTime(entry.createdAt, log.capturedAt)} ago
                  </time>
                </div>
                {entry.reason && <p className="admin-log-reason">“{entry.reason}”</p>}
                {summary && <p className="admin-log-reason">{summary}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const CONNECTION_LABELS = {
  room: 'Room page',
  'embed-player': 'Synchronized video player',
  'embed-playing': 'Now-playing overlay',
  'embed-queue': 'Upcoming queue',
} as const;

function OperationsSection({
  snapshot,
  busy,
  onRefresh,
}: {
  snapshot: OperationsSnapshot | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="admin-card">
      <div className="admin-section-heading">
        <h2>
          <Activity size={18} /> Server activity
        </h2>
        <button className="admin-refresh" type="button" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={busy ? 'spin' : undefined} size={14} /> Refresh
        </button>
      </div>

      {!snapshot ? (
        <p className="admin-empty">Loading server activity…</p>
      ) : (
        <>
          <dl className="admin-operation-counts">
            <div>
              <dt>Open sockets</dt>
              <dd>{snapshot.socketCount}</dd>
            </div>
            <div>
              <dt>Distinct listeners</dt>
              <dd>{snapshot.listenerCount}</dd>
            </div>
            <div>
              <dt>Eligible voters</dt>
              <dd>{snapshot.eligibleVoterCount}</dd>
            </div>
          </dl>

          <p className="admin-operation-clock">
            The API has been up for {elapsedTime(snapshot.processStartedAt, snapshot.capturedAt)}. The
            room clock checked {snapshot.clock.checks.toLocaleString()}{' '}
            {snapshot.clock.checks === 1 ? 'time' : 'times'} and advanced playback{' '}
            {snapshot.clock.advances.toLocaleString()}{' '}
            {snapshot.clock.advances === 1 ? 'time' : 'times'}.
            {snapshot.clock.lastAdvancedAt
              ? ` Its last advance was ${elapsedTime(snapshot.clock.lastAdvancedAt, snapshot.capturedAt)} before this snapshot.`
              : ' It has not advanced playback since this API process started.'}
          </p>

          <div className="admin-section-subheading">
            <h3>Open connections</h3>
            <span>{new Date(snapshot.capturedAt).toLocaleString()}</span>
          </div>
          {snapshot.connections.length === 0 ? (
            <p className="admin-empty">No sockets are open.</p>
          ) : (
            <ul className="admin-connection-list">
              {snapshot.connections.map((connection, index) => (
                <li key={`${connection.connectedAt}-${connection.kind}-${connection.username ?? 'anonymous'}-${index}`}>
                  <div>
                    <strong>
                      {connection.kind === 'room'
                        ? connection.username ?? 'Anonymous browser'
                        : CONNECTION_LABELS[connection.kind]}
                    </strong>
                    <span>
                      {connection.kind === 'room' ? CONNECTION_LABELS.room : 'OBS browser source'}
                    </span>
                  </div>
                  <time dateTime={connection.connectedAt}>
                    Connected for {elapsedTime(connection.connectedAt, snapshot.capturedAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}

          <div className="admin-section-subheading">
            <h3>Database storage</h3>
            <span>{formatBytes(snapshot.storage.databaseBytes)}</span>
          </div>
          <p className="admin-help">
            What PostgreSQL reports for its own tables and indexes. Nothing else on the volume is in
            this figure: the write-ahead log, PostgreSQL's fixed files and container logs sit outside
            it, it says nothing about free disk, and there is no backup job behind it.
          </p>
          <ul className="admin-storage-list">
            {snapshot.storage.groups.map((group) => (
              <li key={group.name}>
                <div className="admin-storage-head">
                  <strong>{group.name}</strong>
                  <span>
                    {formatBytes(group.totalBytes)} · {formatShare(group.share)}
                  </span>
                </div>
                <div className="admin-storage-bar">
                  <span style={{ width: `${Math.min(group.share * 100, 100)}%` }} />
                </div>
                <dl className="admin-storage-figures">
                  <div>
                    <dt>Rows</dt>
                    <dd>{group.rowCount.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Table</dt>
                    <dd>{formatBytes(group.tableBytes)}</dd>
                  </div>
                  <div>
                    <dt>Indexes</dt>
                    <dd>{formatBytes(group.indexBytes)}</dd>
                  </div>
                </dl>
                <p className="admin-meta">{group.tables.join(', ')}</p>
              </li>
            ))}
          </ul>
          <p className="admin-help">
            These groups hold {formatShare(measuredShare(snapshot.storage))} of the database. The rest
            is PostgreSQL's own catalogues and the room it keeps inside its files.
          </p>
        </>
      )}
    </section>
  );
}

/** How much of the database the named groups account for, catalogues aside. */
function measuredShare(storage: OperationsSnapshot['storage']): number {
  return storage.groups.reduce((total, group) => total + group.share, 0);
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1_500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      className="admin-copy"
      type="button"
      aria-label={`Copy the ${label} URL`}
      onClick={() => {
        void copyText(value).then(
          () => setState('copied'),
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Blocked' : 'Copy'}
    </button>
  );
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();

  try {
    // The Clipboard API requires HTTPS. execCommand remains the browser fallback
    // for the documented HTTP setup on another machine in the local network.
    const legacyDocument = document as unknown as {
      execCommand(commandId: 'copy'): boolean;
    };
    if (!legacyDocument.execCommand('copy')) {
      throw new Error('The browser refused to copy the URL.');
    }
  } finally {
    textarea.remove();
  }
}

interface EmbedSourceProps {
  origin: string;
  path: string;
  name: string;
  size: string;
  note?: string;
}

function EmbedSource({ origin, path, name, size, note }: EmbedSourceProps) {
  const url = `${origin}${path}`;

  return (
    <li>
      <div className="admin-embed-head">
        <a className="admin-link" href={path} target="_blank" rel="noreferrer">
          {name} <ExternalLink size={13} />
        </a>
        <span className="admin-embed-detail">{size}</span>
      </div>
      <div className="admin-embed-url">
        <code>{url}</code>
        <CopyButton value={url} label={name} />
      </div>
      {note && <p className="admin-embed-note">{note}</p>}
    </li>
  );
}

function ObsSources() {
  // The pages are prerendered, so the host is only known once this runs in a
  // browser. Until then the paths stand in for the full URLs.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <section className="admin-card">
      <h2>OBS browser sources</h2>
      <p className="admin-help">
        Add any of these as a Browser Source. The player carries the room's audio and stays in sync with
        it; the overlays are transparent and silent.
      </p>
      <ul className="admin-embed-links">
        <EmbedSource origin={origin} path="/embed/player" name="Synchronized video player" size="1920 × 1080" />
        <EmbedSource origin={origin} path="/embed/playing" name="Now-playing overlay" size="1200 × 240" />
        <EmbedSource
          origin={origin}
          path="/embed/queue"
          name="Upcoming queue"
          size="Any width · 600 high"
          note="Rows fill the Browser Source width. Titles scroll when they do not fit."
        />
      </ul>

      <h3>Player variants</h3>
      <ul className="admin-embed-links">
        <EmbedSource
          origin={origin}
          path="/embed/player?captions=on"
          name="Player with captions"
          size="1920 × 1080"
          note="The plain player hides YouTube captions. This one leaves them to YouTube's own setting."
        />
      </ul>

      <h3>Source settings</h3>
      <ul className="admin-steps">
        <li>
          Turn on <strong>Control audio via OBS</strong>, so the mixer owns the volume instead of the
          computer's speakers.
        </li>
        <li>
          Turn on <strong>Shutdown source when not visible</strong>, so nothing plays off-scene. It
          rejoins the room at the right timestamp when it comes back.
        </li>
        <li>
          Leave <strong>Refresh browser source when scene becomes active</strong> off. The shutdown
          already reloads it.
        </li>
        <li>
          Do not crop or cover the player. To use it in several scenes, add the same source to each one
          rather than making copies, or the audio doubles.
        </li>
      </ul>
    </section>
  );
}

interface RuleRowProps {
  rule: RuleSummary;
  busy: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<void>;
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
  entries: RuleEntrySummary[] | undefined;
  index: number;
  total: number;
  onMove: (destination: MoveDestination) => void;
  onToggleEntries: () => void;
  onEntryRemoved: () => void;
}

function RuleRow({
  rule,
  busy,
  act,
  call,
  entries,
  index,
  total,
  onMove,
  onToggleEntries,
  onEntryRemoved,
}: RuleRowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description);

  useEffect(() => {
    setName(rule.name);
    setDescription(rule.description);
  }, [rule.name, rule.description]);

  function save() {
    if (!name.trim()) return;
    void act(async () => {
      await call(`/api/rules/${rule.id}`, 'PATCH', {
        name: name.trim(),
        description: description.trim(),
      });
      setEditing(false);
    }, `Saved "${name.trim()}".`);
  }

  if (editing) {
    return (
      <li>
        <div className="admin-form admin-form-edit">
          <label>
            Rule name
            <input type="text" value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <label className="admin-wide">
            Description
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <div className="admin-row-actions">
            <button type="button" disabled={busy || !name.trim()} onClick={save}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setName(rule.name);
                setDescription(rule.description);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li>
      <div className="admin-row">
        <div>
          <strong className={rule.active ? undefined : 'admin-inactive'}>{rule.name}</strong>
          <span className="admin-meta">
            {rule.enforcement === 'blocklist' ? `${rule.entryCount} blocked` : 'advisory only'}
          </span>
          {!rule.active && <span className="admin-meta">switched off</span>}
          {rule.description && <p className="admin-description">{rule.description}</p>}
        </div>
        <div className="admin-row-actions">
          <div className="admin-move">
            <button
              type="button"
              disabled={busy || index === 0}
              onClick={() => onMove('top')}
              title="Move to top"
              aria-label={`Move ${rule.name} to the top`}
            >
              <ArrowUpToLine size={15} />
            </button>
            <button
              type="button"
              disabled={busy || index === 0}
              onClick={() => onMove('up')}
              title="Move up"
              aria-label={`Move ${rule.name} up`}
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              disabled={busy || index === total - 1}
              onClick={() => onMove('down')}
              title="Move down"
              aria-label={`Move ${rule.name} down`}
            >
              <ChevronDown size={15} />
            </button>
            <button
              type="button"
              disabled={busy || index === total - 1}
              onClick={() => onMove('bottom')}
              title="Move to bottom"
              aria-label={`Move ${rule.name} to the bottom`}
            >
              <ArrowDownToLine size={15} />
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => call(`/api/rules/${rule.id}`, 'PATCH', { active: !rule.active }),
                rule.active ? `"${rule.name}" is switched off.` : `"${rule.name}" is back on.`,
              )
            }
          >
            {rule.active ? (
              <>
                <ToggleRight size={15} /> On
              </>
            ) : (
              <>
                <ToggleLeft size={15} /> Off
              </>
            )}
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            <Pencil size={15} /> Edit
          </button>
          {rule.enforcement === 'blocklist' && (
            <button type="button" onClick={onToggleEntries}>
              {entries ? 'Hide list' : 'Show list'}
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              void act(() => call(`/api/rules/${rule.id}`, 'DELETE'), `Deleted "${rule.name}".`)
            }
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {entries && (
        <BlockForm
          ruleId={rule.id}
          busy={busy}
          act={act}
          call={call}
          onBlocked={onEntryRemoved}
        />
      )}

      {entries && (
        <ul className="admin-entries">
          {entries.length === 0 && <li className="admin-empty">Nothing listed.</li>}
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>
                <em>{entry.entryType}</em> · {entry.label}
                <span className="admin-meta">{entry.provider}</span>
                {entry.note && <span className="admin-meta">{entry.note}</span>}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await call(`/api/rules/entries/${entry.id}`, 'DELETE');
                    onEntryRemoved();
                  }, `Unblocked ${entry.label}.`)
                }
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface SectionProps {
  busy: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<void>;
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
}

/**
 * Adding to a blocklist without waiting for somebody to play the thing.
 *
 * Two ways in, because there are two ways an admin knows what they want gone.
 * A link is read exactly as a request would be, so the same paste blocks one
 * track or everything by whoever published it. A search is for when the name is
 * known and the link is not, and every result offers the same two choices,
 * which is also how a channel is blocked: find one of its videos and block the
 * channel rather than the video.
 *
 * There is no channel search. The library the room searches YouTube with reads
 * videos and playlists and nothing else, and YouTube's own channel search costs
 * a hundred quota units a query for something any video by that channel already
 * answers for free.
 *
 * On SoundCloud the same button blocks the account that uploaded the track,
 * which is that provider's equivalent of a channel.
 */
function BlockForm({
  ruleId,
  busy,
  act,
  call,
  onBlocked,
}: SectionProps & { ruleId: string; onBlocked: () => void }) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const typed = value.trim();
  const isLink = /^https?:\/\//i.test(typed);

  function block(url: string, entryType: 'track' | 'artist', label: string) {
    void act(async () => {
      await call(`/api/rules/${ruleId}/entries`, 'POST', { url, entryType });
      setValue('');
      setResults([]);
      // The list is folded shut so the next look at it reads from the server
      // rather than from what was on screen before the block.
      onBlocked();
    }, `Blocked ${label}.`);
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    if (typed.length < 2) return;
    if (isLink) {
      // A link needs no searching: it already names one track.
      block(typed, 'track', 'that track');
      return;
    }
    void act(async () => {
      setSearching(true);
      try {
        const payload = await call(`/api/search?q=${encodeURIComponent(typed)}`);
        setResults(payload.results);
      } finally {
        setSearching(false);
      }
    }, `Searched for "${typed}".`);
  }

  return (
    <div className="admin-block">
      <form onSubmit={search}>
        <input
          value={value}
          maxLength={400}
          placeholder="Paste a YouTube or SoundCloud link, or search for a track"
          aria-label="Track to block"
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        {isLink ? (
          <>
            <button type="button" disabled={busy} onClick={() => block(typed, 'track', 'that track')}>
              <Ban size={14} /> Block track
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => block(typed, 'artist', 'that channel')}
            >
              <Ban size={14} /> Block channel
            </button>
          </>
        ) : (
          <button type="submit" disabled={busy || typed.length < 2}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        )}
      </form>

      {results.length > 0 && (
        <ul className="admin-block-results">
          {results.map((result) => (
            <li key={result.url}>
              {result.thumbnailUrl ? (
                <img src={result.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span className="admin-block-art"><ListMusic size={14} /></span>
              )}
              <div>
                <a href={result.url} target="_blank" rel="noreferrer">{result.title}</a>
                <span>
                  {result.provider === 'youtube' ? 'YouTube' : 'SoundCloud'} · {result.artist}
                </span>
              </div>
              <div className="admin-row-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => block(result.url, 'track', `"${result.title}"`)}
                >
                  Track
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => block(result.url, 'artist', result.artist)}
                  title={
                    result.provider === 'youtube'
                      ? 'Block everything from this channel'
                      : 'Block everything from this SoundCloud account'
                  }
                >
                  {result.provider === 'youtube' ? 'Channel' : 'Account'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "United Arab Emirates (AE)" — the text the region box shows for a code. */
function regionLabel(code: string, regions: PlaybackRegion[]): string {
  const match = regions.find((region) => region.code === code);
  return match ? `${match.name} (${match.code})` : code;
}

/**
 * Accepts either half of the label: a bare code typed straight in, or a name
 * picked from the list, which arrives with its code in trailing brackets.
 */
function regionCode(text: string, regions: PlaybackRegion[]): string | null {
  const trimmed = text.trim();
  const bracketed = /\(([A-Za-z]{2})\)$/.exec(trimmed)?.[1];
  if (bracketed) return bracketed.toUpperCase();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const named = regions.find(
    (region) => region.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return named?.code ?? null;
}

function SettingsSection({
  settings,
  regions,
  busy,
  act,
  call,
}: SectionProps & { settings: Settings; regions: PlaybackRegion[] }) {
  const [draft, setDraft] = useState(settings);
  const [cooldown, setCooldown] = useState(() => cooldownParts(settings.repeatCooldownSeconds));
  const [regionText, setRegionText] = useState(() => regionLabel(settings.targetCountry, regions));
  useEffect(() => {
    setDraft(settings);
    setCooldown(cooldownParts(settings.repeatCooldownSeconds));
  }, [settings]);
  useEffect(
    () => setRegionText(regionLabel(settings.targetCountry, regions)),
    [settings.targetCountry, regions],
  );

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void act(() => call('/api/settings', 'PATCH', draft), 'Room settings saved.');
  }

  return (
    <section className="admin-card">
      <h2>Room settings</h2>
      <form className="admin-form" onSubmit={submit}>
        <label className="admin-wide">
          Room description
          <textarea
            rows={8}
            value={draft.description}
            placeholder="What this room is, and anything listeners should know."
            onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
          />
          <small>Shown on the player. Leave a blank line between paragraphs.</small>
        </label>

        <label>
          Track length limit (minutes)
          <input
            type="number"
            min={1}
            max={30}
            value={Math.round(draft.maxDurationSeconds / 60)}
            onChange={(event) =>
              setDraft({ ...draft, maxDurationSeconds: Number(event.currentTarget.value) * 60 })
            }
          />
        </label>

        <label>
          Track repeat cooldown
          <span className="admin-unit-field">
            <input
              type="number"
              min={300 / COOLDOWN_UNIT_SECONDS[cooldown.unit]}
              max={2_592_000 / COOLDOWN_UNIT_SECONDS[cooldown.unit]}
              step="any"
              value={cooldown.amount}
              onChange={(event) => {
                const amount = Number(event.currentTarget.value);
                setCooldown({ ...cooldown, amount });
                setDraft({
                  ...draft,
                  repeatCooldownSeconds: cooldownSeconds(amount, cooldown.unit),
                });
              }}
            />
            <select
              aria-label="Track repeat cooldown unit"
              value={cooldown.unit}
              onChange={(event) => {
                const unit = event.currentTarget.value as CooldownUnit;
                const amount = draft.repeatCooldownSeconds / COOLDOWN_UNIT_SECONDS[unit];
                setCooldown({ amount, unit });
              }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </span>
          <small>How long after a track starts before it can be requested again. 5 minutes to 30 days.</small>
        </label>

        <label>
          Playback region
          <input
            type="text"
            list="playback-regions"
            value={regionText}
            placeholder="Start typing a country"
            onChange={(event) => {
              const text = event.currentTarget.value;
              setRegionText(text);
              const code = regionCode(text, regions);
              if (code) setDraft({ ...draft, targetCountry: code });
            }}
            onBlur={() => setRegionText(regionLabel(draft.targetCountry, regions))}
          />
          <datalist id="playback-regions">
            {regions.map((region) => (
              <option key={region.code} value={`${region.name} (${region.code})`} />
            ))}
          </datalist>
          <small>
            {REGION_HINT} Currently {draft.targetCountry}.
          </small>
        </label>

        <label>
          Downvote skip
          <select
            value={draft.skipMode}
            onChange={(event) =>
              setDraft({ ...draft, skipMode: event.currentTarget.value as Settings['skipMode'] })
            }
          >
            <option value="absolute">A fixed number of downvotes</option>
            <option value="ratio">A share of the listeners</option>
          </select>
        </label>

        {draft.skipMode === 'absolute' ? (
          <label>
            Downvotes needed
            <input
              type="number"
              min={1}
              max={500}
              value={draft.skipDownvotes}
              onChange={(event) =>
                setDraft({ ...draft, skipDownvotes: Number(event.currentTarget.value) })
              }
            />
          </label>
        ) : (
          <label>
            Percent of listeners
            <input
              type="number"
              min={1}
              max={100}
              value={draft.skipRatioPercent}
              onChange={(event) =>
                setDraft({ ...draft, skipRatioPercent: Number(event.currentTarget.value) })
              }
            />
          </label>
        )}

        <label className="admin-check">
          <input
            type="checkbox"
            checked={draft.revealRequester}
            onChange={(event) => setDraft({ ...draft, revealRequester: event.currentTarget.checked })}
          />
          Show who requested each track
          <small>
            Turn this off to hide requesters from listeners until a track is ending. Admins always see
            them.
          </small>
        </label>

        <button type="submit" disabled={busy}>
          <Check size={16} /> Save settings
        </button>
      </form>
    </section>
  );
}

function NewRuleForm({ busy, act, call }: SectionProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enforcement, setEnforcement] = useState<'blocklist' | 'advisory'>('blocklist');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void act(async () => {
      await call('/api/rules', 'POST', { name: name.trim(), description: description.trim(), enforcement });
      setName('');
      setDescription('');
    }, `Added "${name.trim()}".`);
  }

  return (
    <form className="admin-form admin-form-inline" onSubmit={submit}>
      <label>
        Rule name
        <input
          type="text"
          value={name}
          placeholder="No meme songs"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        Description
        <input
          type="text"
          value={description}
          placeholder="Shown to listeners"
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <label>
        Kind
        <select
          value={enforcement}
          onChange={(event) => setEnforcement(event.currentTarget.value as 'blocklist' | 'advisory')}
        >
          <option value="blocklist">Keeps a blocklist</option>
          <option value="advisory">Advisory only</option>
        </select>
      </label>
      <button type="submit" disabled={busy || !name.trim()}>
        Add rule
      </button>
    </form>
  );
}
