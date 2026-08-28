import { Ban, Check, ListMusic, Loader2, Shield, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import type {
  RoomMember,
  RoomSnapshot,
  RuleEntrySummary,
  RuleSummary,
} from '../shared/contracts';
import './AdminPanel.css';

interface AdminPanelProps {
  apiUrl: string;
}

type Settings = RoomSnapshot['settings'];

const REGION_HINT = 'Two-letter country code the YouTube checks run against, such as AE.';

export default function AdminPanel({ apiUrl }: AdminPanelProps) {
  const [me, setMe] = useState<RoomSnapshot['me']>(null);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<RuleSummary[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [entries, setEntries] = useState<Record<string, RuleEntrySummary[]>>({});
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
        <p>Room controls are limited to moderators.</p>
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
        <a className="admin-link" href="/player">
          Back to the room
        </a>
      </header>

      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-notice">{notice}</p>}

      {settings && <SettingsSection settings={settings} busy={busy} act={act} call={call} />}

      <section className="admin-card">
        <h2>
          <Ban size={18} /> Rules
        </h2>
        <p className="admin-help">
          A blocklist rule collects the tracks and artists that broke it, so blocking a song under it
          teaches the room. An advisory rule is only shown to listeners.
        </p>

        <NewRuleForm busy={busy} act={act} call={call} />

        {rules.length === 0 ? (
          <p className="admin-empty">No rules yet.</p>
        ) : (
          <ul className="admin-list">
            {rules.map((rule) => (
              <li key={rule.id}>
                <div className="admin-row">
                  <div>
                    <strong>{rule.name}</strong>
                    <span className="admin-meta">
                      {rule.enforcement === 'blocklist'
                        ? `${rule.entryCount} blocked`
                        : 'advisory only'}
                    </span>
                    {rule.description && <p className="admin-description">{rule.description}</p>}
                  </div>
                  <div className="admin-row-actions">
                    {rule.enforcement === 'blocklist' && (
                      <button type="button" onClick={() => void toggleEntries(rule.id)}>
                        {entries[rule.id] ? 'Hide list' : 'Show list'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => call(`/api/rules/${rule.id}`, 'DELETE'),
                          `Deleted "${rule.name}".`,
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

                {entries[rule.id] && (
                  <ul className="admin-entries">
                    {entries[rule.id]!.length === 0 && <li className="admin-empty">Nothing listed.</li>}
                    {entries[rule.id]!.map((entry) => (
                      <li key={entry.id}>
                        <span>
                          <em>{entry.entryType}</em> · {entry.label}
                          <span className="admin-meta">{entry.provider}</span>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await call(`/api/rules/entries/${entry.id}`, 'DELETE');
                              setEntries(({ [rule.id]: _drop, ...rest }) => rest);
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
                  {member.role === 'admin' && (
                    <span className="admin-meta">
                      <Shield size={13} /> {member.isRoot ? 'root admin' : 'admin'}
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
                  <button
                    type="button"
                    disabled={busy || member.isRoot}
                    title={member.isRoot ? 'Root admins are set in the environment' : undefined}
                    onClick={() =>
                      void act(
                        () =>
                          call(`/api/admins/${member.id}`, 'PATCH', {
                            role: member.role === 'admin' ? 'listener' : 'admin',
                          }),
                        member.role === 'admin'
                          ? `${member.username} is no longer an admin.`
                          : `${member.username} is now an admin.`,
                      )
                    }
                  >
                    {member.role === 'admin' ? 'Remove admin' : 'Make admin'}
                  </button>
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

interface SectionProps {
  busy: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<void>;
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
}

function SettingsSection({ settings, busy, act, call }: SectionProps & { settings: Settings }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void act(() => call('/api/settings', 'PATCH', draft), 'Room settings saved.');
  }

  return (
    <section className="admin-card">
      <h2>Room settings</h2>
      <form className="admin-form" onSubmit={submit}>
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
            maxLength={2}
            value={draft.targetCountry}
            onChange={(event) =>
              setDraft({ ...draft, targetCountry: event.currentTarget.value.toUpperCase() })
            }
          />
          <small>{REGION_HINT}</small>
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
