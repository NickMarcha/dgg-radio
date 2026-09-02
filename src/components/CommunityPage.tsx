import { ListMusic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_EMOTE } from '../shared/contracts';
import { userClass } from './flair';
import type {
  ApiErrorBody,
  CommunityStats,
  HistoryEntry,
  LegacyHistoryPage,
  LegacyPlay,
  RoomUser,
  UserProfile,
} from '../shared/contracts';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import { usePlaylistLibrary, type PlaylistLibraryController } from './usePlaylistLibrary';
import './CommunityPage.css';

interface CommunityPageProps {
  apiUrl: string;
  view: 'profile' | 'stats' | 'history';
}

type PageData = UserProfile | CommunityStats | HistoryEntry[];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function profileUrl(username: string): string {
  return `/profile/${encodeURIComponent(username)}`;
}

function Avatar({
  user,
  large = false,
  title,
}: {
  user: RoomUser;
  large?: boolean;
  title?: string;
}) {
  const base = large ? 'community-avatar community-avatar-large avatar-frame' : 'community-avatar avatar-frame';

  return (
    <span className={userClass(user, base)} title={title}>
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" />
      ) : (
        <span className={`emote ${user.topEmote ?? DEFAULT_EMOTE}`} />
      )}
    </span>
  );
}

const TEAM_EXPLAINER =
  'Team is counted from your Destiny chat: whichever of "yee" or "pepe" you say at least ' +
  'three times out of four. A more even mix, or neither word, leaves you unassigned.';

const EMOTE_EXPLAINER =
  'Your profile emote is the dancing or music emote you use most in Destiny chat. ' +
  'MMMM stands in until your chat has been counted.';

function TeamText({ team, title }: { team: RoomUser['team']; title?: string }) {
  if (!team) {
    return <span className="team-unassigned" title={title}>team unassigned</span>;
  }
  return (
    <span className={`team-${team}`} title={title}>
      {team === 'pepe' ? 'Team PEPE' : 'Team YEE'}
    </span>
  );
}

function Score({ value }: { value: number }) {
  return (
    <span className={value > 0 ? 'score-positive' : value < 0 ? 'score-negative' : undefined}>
      {value > 0 ? '+' : ''}{value}
    </span>
  );
}

function HistoryTable({
  entries,
  showRequester,
  library,
}: {
  entries: HistoryEntry[];
  showRequester: boolean;
  library?: PlaylistLibraryController;
}) {
  if (entries.length === 0) return <p className="community-empty">No tracks have played yet.</p>;

  return (
    <div className="community-table-wrap">
      <table className="community-table history-table">
        <thead>
          <tr>
            <th>Track</th>
            {showRequester && <th>Requested by</th>}
            <th>Played</th>
            <th>Votes</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <div className="history-track">
                  {entry.media.thumbnailUrl ? (
                    <img src={entry.media.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="history-art-empty"><ListMusic size={16} /></span>
                  )}
                  <div>
                    <span className="history-track-title">
                      <a href={entry.media.canonicalUrl} target="_blank" rel="noreferrer">
                        {entry.media.title}
                      </a>
                      {library?.signedIn && (
                        <SaveToPlaylistButton media={entry.media} library={library} compact />
                      )}
                    </span>
                    <span>
                      <span className={`provider-text provider-${entry.media.provider}`}>
                        {entry.media.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}
                      </span>
                      {' · '}{entry.media.artist}{' · '}{formatDuration(entry.media.durationSeconds)}
                    </span>
                  </div>
                </div>
              </td>
              {showRequester && (
                <td data-label="Requested by">
                  <a
                    className={userClass(entry.requestedBy, 'profile-link')}
                    href={profileUrl(entry.requestedBy.username)}
                  >
                    {entry.requestedBy.username}
                  </a>
                </td>
              )}
              <td data-label="Played"><time dateTime={entry.startedAt}>{formatDate(entry.startedAt)}</time></td>
              <td data-label="Votes"><span className="vote-up">+{entry.upvotes}</span> <span className="vote-down">-{entry.downvotes}</span></td>
              <td data-label="Result" className={`history-status status-${entry.status}`}>{entry.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

/** Your own team and emote come from Destiny chat, and can be recounted daily. */
function ChatCheck({ profile, apiUrl }: { profile: UserProfile; apiUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const checkedAt = profile.chatCheckedAt ? new Date(profile.chatCheckedAt).getTime() : null;
  const readyAt = checkedAt === null ? null : checkedAt + CHECK_COOLDOWN_MS;
  const waiting = readyAt !== null && readyAt > Date.now();

  async function check() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${apiUrl}/api/me/chat-check`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? 'The check did not run.');
      setNotice('Counted. Reload to see the result.');
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The check did not run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="profile-check">
      <button type="button" disabled={busy || waiting} onClick={() => void check()}>
        {busy ? 'Counting…' : 'Recount my chat'}
      </button>
      <span>
        {notice ??
          (waiting
            ? `Counted ${formatDate(profile.chatCheckedAt!)}. Once a day.`
            : 'Reads your yee and pepe messages, and your emotes, from Destiny chat.')}
      </span>
    </p>
  );
}

function ProfileView({ profile, apiUrl }: { profile: UserProfile; apiUrl: string }) {
  const { stats } = profile;
  const library = usePlaylistLibrary(apiUrl, profile.history.map(({ media }) => media.id));
  return (
    <>
      <header className="profile-heading">
        <Avatar user={profile.user} large title={EMOTE_EXPLAINER} />
        <div>
          <h1 className={userClass(profile.user)}>{profile.user.username}</h1>
          <p>
            <TeamText team={profile.user.team} title={TEAM_EXPLAINER} /> ·{' '}
            Joined {formatDate(profile.joinedAt)}
          </p>
          {profile.isSelf && <ChatCheck profile={profile} apiUrl={apiUrl} />}
        </div>
      </header>

      <dl className="stat-strip profile-stats">
        <div><dt>Requests</dt><dd>{stats.requests}</dd></div>
        <div><dt>Plays</dt><dd>{stats.plays}</dd></div>
        <div><dt>Jammer score</dt><dd><Score value={stats.score} /></dd></div>
        <div><dt>Votes per play</dt><dd>{stats.averageVotesPerPlay.toFixed(1)}</dd></div>
        <div><dt>Score per play</dt><dd>{stats.averageScorePerPlay > 0 ? '+' : ''}{stats.averageScorePerPlay.toFixed(1)}</dd></div>
      </dl>

      {library.error && (
        <p className="community-error" role="alert">
          {library.error} Saving to a playlist is unavailable.
        </p>
      )}
      <section className="community-section">
        <div className="community-section-heading">
          <h2>Play history</h2>
          <span>{stats.played} finished · {stats.skipped} skipped</span>
        </div>
        <HistoryTable entries={profile.history} showRequester={false} library={library} />
      </section>
    </>
  );
}

function StatsView({ stats }: { stats: CommunityStats }) {
  return (
    <>
      <header className="community-title">
        <h1>Stats</h1>
        <p>Votes received on tracks that reached the player.</p>
      </header>

      <dl className="stat-strip">
        <div><dt>Listeners</dt><dd>{stats.totals.members}</dd></div>
        <div><dt>Tracks played</dt><dd>{stats.totals.tracksPlayed}</dd></div>
        <div><dt>Votes cast</dt><dd>{stats.totals.votes}</dd></div>
      </dl>

      <section className="community-section">
        <div className="community-section-heading">
          <h2>Yee vs Pepe</h2>
          <span>Unassigned means Destiny did not return a team flair.</span>
        </div>
        <div className="community-table-wrap">
          <table className="community-table team-table">
            <thead><tr><th>Team</th><th>Members</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr></thead>
            <tbody>
              {stats.teams.map((team) => (
                <tr key={team.team}>
                  <td className={`team-name team-name-${team.team}`}>
                    {team.team === 'pepe' ? 'PEPE' : team.team === 'yee' ? 'YEE' : 'Unassigned'}
                  </td>
                  <td data-label="Members">{team.members}</td>
                  <td data-label="Plays">{team.plays}</td>
                  <td data-label="Up">{team.upvotes}</td>
                  <td data-label="Down">{team.downvotes}</td>
                  <td data-label="Score"><Score value={team.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="community-section">
        <div className="community-section-heading">
          <h2>Top Played</h2>
          <span>Times a track reached the player, then its score</span>
        </div>
        {stats.tracks.length ? (
          <div className="community-table-wrap">
            <table className="community-table track-table">
              <thead><tr><th>#</th><th>Track</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr></thead>
              <tbody>
                {stats.tracks.map((entry, index) => (
                  <tr key={entry.media.id}>
                    <td>{index + 1}</td>
                    <td>
                      <div className="history-track">
                        {entry.media.thumbnailUrl ? (
                          <img src={entry.media.thumbnailUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="history-art-empty"><ListMusic size={16} /></span>
                        )}
                        <div>
                          <a href={entry.media.canonicalUrl} target="_blank" rel="noreferrer">
                            {entry.media.title}
                          </a>
                          <span>
                            <span className={`provider-text provider-${entry.media.provider}`}>
                              {entry.media.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}
                            </span>
                            {' · '}{entry.media.artist}{' · '}{formatDuration(entry.media.durationSeconds)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td data-label="Plays">{entry.plays}</td>
                    <td data-label="Up">{entry.upvotes}</td>
                    <td data-label="Down">{entry.downvotes}</td>
                    <td data-label="Score"><Score value={entry.score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="community-empty">No tracks have played yet.</p>}
      </section>

      <section className="community-section">
        <div className="community-section-heading"><h2>Top Jammers</h2><span>Score, then number of plays</span></div>
        {stats.jammers.length ? (
          <div className="community-table-wrap">
            <table className="community-table jammer-table">
              <thead><tr><th>#</th><th>Jammer</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr></thead>
              <tbody>
                {stats.jammers.map((entry, index) => (
                  <tr key={entry.user.id}>
                    <td>{index + 1}</td>
                    <td>
                      <div className="jammer-user">
                        <Avatar user={entry.user} />
                        <a className={userClass(entry.user, 'profile-link')} href={profileUrl(entry.user.username)}>
                          {entry.user.username}
                        </a>
                        <TeamText team={entry.user.team} />
                      </div>
                    </td>
                    <td data-label="Plays">{entry.plays}</td>
                    <td data-label="Up">{entry.upvotes}</td>
                    <td data-label="Down">{entry.downvotes}</td>
                    <td data-label="Score"><Score value={entry.score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="community-empty">No tracks have received votes yet.</p>}
      </section>
    </>
  );
}

const LEGACY_PAGE = 50;

/**
 * What the room played on QueUp, before this site existed. It is an archive of
 * someone else's records, so it reads differently on purpose: the names are
 * QueUp names with no profile behind them, the votes were cast there, and none
 * of it counts towards anything here.
 */
function LegacyHistory({ apiUrl }: { apiUrl: string }) {
  const [entries, setEntries] = useState<LegacyPlay[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (before: string | null) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: String(LEGACY_PAGE) });
      if (before) query.set('before', before);
      const response = await fetch(`${apiUrl}/api/history/legacy?${query}`);
      if (!response.ok) throw new Error('The QueUp archive could not be read.');
      const page = (await response.json()) as LegacyHistoryPage;
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
      setTotal(page.total);
      setCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The QueUp archive could not be read.');
    } finally {
      setLoading(false);
    }
  };

  // The archive never changes, so it is read once and then only extended.
  useEffect(() => {
    void load(null);
  }, [apiUrl]);

  // An empty archive is the normal state for a room nobody has imported into,
  // so it says nothing at all rather than explaining its own absence.
  if (!error && total === 0) return null;

  return (
    <section className="community-section legacy-section">
      <div className="community-section-heading">
        <h2>Before DGG Radio</h2>
        <span>
          {total.toLocaleString()} plays imported from QueUp · names are QueUp names
        </span>
      </div>
      {error ? (
        <p className="community-error" role="alert">{error}</p>
      ) : (
        <>
          <div className="community-table-wrap">
            <table className="community-table history-table legacy-table">
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Requested by</th>
                  <th>Played</th>
                  <th>Votes</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div className="history-track">
                        {entry.thumbnailUrl ? (
                          <img src={entry.thumbnailUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="history-art-empty"><ListMusic size={16} /></span>
                        )}
                        <div>
                          <span className="history-track-title">
                            {entry.canonicalUrl ? (
                              <a href={entry.canonicalUrl} target="_blank" rel="noreferrer">{entry.title}</a>
                            ) : (
                              entry.title
                            )}
                          </span>
                          <span>
                            <span className={`provider-text provider-${entry.provider}`}>
                              {entry.provider === 'youtube' ? 'YouTube' : 'SoundCloud'}
                            </span>
                            {' · '}{formatDuration(entry.durationSeconds)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td data-label="Requested by" className="legacy-requester">{entry.requesterName}</td>
                    <td data-label="Played"><time dateTime={entry.playedAt}>{formatDate(entry.playedAt)}</time></td>
                    <td data-label="Votes">
                      <span className="vote-up">+{entry.upvotes}</span> <span className="vote-down">-{entry.downvotes}</span>
                    </td>
                    <td data-label="Result" className={`history-status status-${entry.skipped ? 'skipped' : 'played'}`}>
                      {entry.skipped ? 'skipped' : 'played'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && (
            <button type="button" className="legacy-more" disabled={loading} onClick={() => void load(cursor)}>
              {loading ? 'Loading...' : 'Load older'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryView({ entries, apiUrl }: { entries: HistoryEntry[]; apiUrl: string }) {
  const library = usePlaylistLibrary(apiUrl, entries.map(({ media }) => media.id));
  return (
    <>
      <header className="community-title">
        <h1>History</h1>
        <p>The latest completed and skipped tracks, newest first.</p>
      </header>
      {library.error && (
        <p className="community-error" role="alert">
          {library.error} Saving to a playlist is unavailable.
        </p>
      )}
      <section className="community-section history-section">
        <HistoryTable entries={entries} showRequester library={library} />
      </section>
      <LegacyHistory apiUrl={apiUrl} />
    </>
  );
}

export default function CommunityPage({ apiUrl, view }: CommunityPageProps) {
  const [data, setData] = useState<PageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let endpoint = view === 'stats' ? '/api/stats' : '/api/history?limit=100';
        if (view === 'profile') {
          const username = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).at(-1) ?? '');
          if (!username || username.toLowerCase() === 'profile') throw new Error('Choose a listener from stats or history.');
          endpoint = `/api/profiles/${encodeURIComponent(username)}`;
        }

        const response = await fetch(`${apiUrl}${endpoint}`, { credentials: 'include' });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          throw new Error(body?.error.message ?? 'The page could not be loaded.');
        }
        const body = await response.json();
        const next = view === 'history' ? body.history : body;
        if (!cancelled) {
          setData(next);
          if (view === 'profile') document.title = `${(next as UserProfile).user.username} · DGG Radio`;
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'The page could not be loaded.');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [apiUrl, view]);

  return (
    <div className="community-app">
      <SiteHeader apiUrl={apiUrl} />
      <SiteNav active={view === 'stats' || view === 'history' ? view : undefined} />
      <main className="community-main">
        {error ? <div className="community-error" role="alert">{error}</div> : !data ? (
          <p className="community-loading">Loading...</p>
        ) : view === 'profile' ? (
          <ProfileView profile={data as UserProfile} apiUrl={apiUrl} />
        ) : view === 'stats' ? (
          <StatsView stats={data as CommunityStats} />
        ) : (
          <HistoryView entries={data as HistoryEntry[]} apiUrl={apiUrl} />
        )}
      </main>
      <footer className="community-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
