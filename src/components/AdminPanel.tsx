import {
  ArrowDownToLine,
  ArrowUpToLine,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListMusic,
  Loader2,
  Shield,
  Pencil,
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
  UserRole,
} from '../shared/contracts';
import { moveItem, type MoveDestination } from './reorder';
import './AdminPanel.css';

interface AdminPanelProps {
  apiUrl: string;
}

type Settings = RoomSnapshot['settings'];

const REGION_HINT = 'The country the YouTube availability checks run against.';

export default function AdminPanel({ apiUrl }: AdminPanelProps) {
  const [me, setMe] = useState<RoomSnapshot['me']>(null);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [entries, setEntries] = useState<Record<string, RuleEntrySummary[]>>({});
  const [regions, setRegions] = useState<PlaybackRegion[]>([]);
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

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-notice">{notice}</p>}

      {settings && (
        <SettingsSection settings={settings} regions={regions} busy={busy} act={act} call={call} />
      )}

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

      <section className="admin-card">
        <h2>
          <Users size={18} /> People
        </h2>
        <input
          type="search"
          value={search}
          placeholder="Search by username"
          onChange={(event) => setSearch(event.currentTarget.value)}
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
    </main>
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
  const [regionText, setRegionText] = useState(() => regionLabel(settings.targetCountry, regions));
  useEffect(() => setDraft(settings), [settings]);
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
