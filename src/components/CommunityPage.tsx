import { ChevronLeft, ChevronRight, ListMusic, Play, Search, X } from 'lucide-react';
import { useEffect, useState, type SubmitEvent } from 'react';
import { DEFAULT_EMOTE } from '../shared/contracts';
import { userClass } from './flair';
import type {
  ApiErrorBody,
  AvailablePeriod,
  CommunityStats,
  GenreCount,
  GenreStats,
  HistoryEntry,
  LegacyJammerStats,
  LegacyPlay,
  LegacyTrackStats,
  RoomUser,
  UserProfile,
} from '../shared/contracts';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import GenreTags, { GenreCredit } from './TrackGenres';
import { ArtistLink, ProviderLink, TrackLink } from './TrackLinks';
import { usePlaylistLibrary, type PlaylistLibraryController } from './usePlaylistLibrary';
import './CommunityPage.css';

interface CommunityPageProps {
  apiUrl: string;
  view: 'profile' | 'stats' | 'history';
}



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

/**
 * Requesting a track from a list of ones already played. It is the room's
 * ordinary request, so everything the room decides about a request still
 * applies and the answer comes back as a notice rather than a new row here.
 */
function QueueButton({
  title,
  busy,
  onQueue,
}: {
  title: string;
  busy: boolean;
  onQueue: () => void;
}) {
  return (
    <button
      type="button"
      className="history-queue-button"
      title="Add to your queue"
      aria-label={`Add ${title} to your queue`}
      disabled={busy}
      onClick={onQueue}
    >
      <Play size={15} />
    </button>
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
  onQueue,
  queueing,
  onSelectGenre,
  empty = 'No tracks have played yet.',
}: {
  entries: HistoryEntry[];
  showRequester: boolean;
  library?: PlaylistLibraryController;
  /** Absent where requesting makes no sense, such as somebody else's profile. */
  onQueue?: (entry: HistoryEntry) => void;
  queueing?: string | null;
  /** Absent on a list that cannot be narrowed, such as a profile's own plays. */
  onSelectGenre?: (genre: string) => void;
  /** An empty list means something different once a search has narrowed it. */
  empty?: string;
}) {
  if (entries.length === 0) return <p className="community-empty">{empty}</p>;

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
                      <TrackLink
                        provider={entry.media.provider}
                        providerMediaId={entry.media.providerMediaId}
                        title={entry.media.title}
                      />
                      {library?.signedIn && (
                        <>
                          <SaveToPlaylistButton
                            target={{
                              kind: 'media',
                              mediaId: entry.media.id,
                              title: entry.media.title,
                            }}
                            library={library}
                            compact
                          />
                          {onQueue && (
                            <QueueButton
                              title={entry.media.title}
                              busy={queueing === entry.id}
                              onQueue={() => onQueue(entry)}
                            />
                          )}
                        </>
                      )}
                    </span>
                    <span>
                      <ProviderLink
                        provider={entry.media.provider}
                        url={entry.media.canonicalUrl}
                      />
                      {' · '}
                      <ArtistLink
                        provider={entry.media.provider}
                        providerArtistId={entry.media.providerArtistId}
                        artist={entry.media.artist}
                      />
                      {' · '}{formatDuration(entry.media.durationSeconds)}
                      <GenreTags genres={entry.genres} onSelect={onSelectGenre} />
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

/** Which history a table on the stats page is about. */
type StatsScope = 'room' | 'queup';

/** Genre adds a third: the two counted together, stacked rather than summed. */
type GenreScope = 'both' | StatsScope;

const GENRE_SCOPES: { scope: GenreScope; label: string }[] = [
  { scope: 'both', label: 'Both' },
  { scope: 'room', label: 'This room' },
  { scope: 'queup', label: 'QueUp' },
];

/**
 * What the community plays, by genre.
 *
 * The two histories are counted separately and shown that way, because they are
 * wildly different sizes: this room has a few hundred plays against the
 * archive's tens of thousands, so a single merged bar would be a chart of
 * QueUp with a rounding error on the end. Reading them together is still
 * useful, which is what `Both` is for -- it stacks the two rather than adding
 * them into one anonymous number.
 */
function GenreSection({ genres }: { genres: GenreStats }) {
  const [scope, setScope] = useState<GenreScope>('both');
  if (genres.genres.length === 0) return null;

  const plays = (row: GenreCount) =>
    scope === 'room'
      ? row.roomPlays
      : scope === 'queup'
        ? row.archivePlays
        : row.roomPlays + row.archivePlays;

  const shown = genres.genres
    .filter((row) => plays(row) > 0)
    .sort((left, right) => plays(right) - plays(left));
  const largest = Math.max(1, ...shown.map(plays));
  const { labelledTracks, tracks } = genres.coverage;
  const covered = tracks > 0 ? ((labelledTracks / tracks) * 100).toFixed(1) : '0.0';

  return (
    <section className="community-section">
      <div className="community-section-heading">
        <h2>Genres</h2>
        <span>
          {labelledTracks.toLocaleString()} of {tracks.toLocaleString()} tracks labelled ({covered}%)
        </span>
      </div>

      <div className="stats-scope" role="group" aria-label="Which history">
        {GENRE_SCOPES.map((option) => (
          <button
            key={option.scope}
            type="button"
            className={scope === option.scope ? 'is-active' : undefined}
            aria-pressed={scope === option.scope}
            onClick={() => setScope(option.scope)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="community-empty">Nothing labelled has played there yet.</p>
      ) : (
        <ol className="genre-chart">
          {shown.map((row) => {
            const total = plays(row);
            const width = (total / largest) * 100;
            const roomShare = total > 0 ? (row.roomPlays / total) * 100 : 0;
            return (
              <li key={row.genre}>
                <span className="genre-name">
                  <a
                    href={`/history?genre=${encodeURIComponent(row.genre)}${scope === 'queup' ? '&tab=queup' : ''}`}
                  >
                    {row.genre}
                  </a>
                  {row.sources.map((source) => (
                    <span
                      key={source}
                      className={`genre-source genre-source-${source}`}
                      title={
                        source === 'discogs'
                          ? 'A Discogs genre or style. Discogs uses about fifteen broad genres with a sharper style list under them.'
                          : 'A MusicBrainz genre. MusicBrainz uses a folksonomy of hundreds, so its names are narrower.'
                      }
                    >
                      {source === 'discogs' ? 'D' : 'MB'}
                    </span>
                  ))}
                </span>
                <span className="genre-bar" aria-hidden="true">
                  <span className="genre-bar-fill" style={{ width: `${width}%` }}>
                    {scope === 'both' && <span className="genre-bar-room" style={{ width: `${roomShare}%` }} />}
                  </span>
                </span>
                <span className="genre-plays">
                  {total.toLocaleString()}
                  {scope === 'both' && row.roomPlays > 0 && (
                    <small> · {row.roomPlays.toLocaleString()} here</small>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <p className="genre-note">
        Counted from plays of tracks a source names, in that source's own words, so a
        broad <span className="genre-source genre-source-discogs">D</span> Discogs genre
        and a narrow <span className="genre-source genre-source-musicbrainz">MB</span>{' '}
        MusicBrainz one sit side by side rather than being merged into each other.
        Genres that describe an artist rather than a track are left out.
      </p>
      <GenreCredit shown />
    </section>
  );
}

/**
 * The room's own numbers, or the QueUp years it inherited. Offered per table
 * rather than once for the page, because the two are answers to different
 * questions and somebody comparing them wants one of each on screen.
 */
function ScopeToggle({
  scope,
  hasArchive,
  onScope,
}: {
  scope: StatsScope;
  hasArchive: boolean;
  onScope: (scope: StatsScope) => void;
}) {
  if (!hasArchive) return null;
  return (
    <div className="stats-scope" role="group" aria-label="Which history">
      {[
        { scope: 'room' as const, label: 'This room' },
        { scope: 'queup' as const, label: 'QueUp' },
      ].map((option) => (
        <button
          key={option.scope}
          type="button"
          className={scope === option.scope ? 'is-active' : undefined}
          aria-pressed={scope === option.scope}
          onClick={() => onScope(option.scope)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The archive's most played. There is no `media` row behind any of these and no
 * duration, because QueUp's records are all there is: a provider id, a title,
 * and what the votes came to.
 */
function LegacyTrackTable({ tracks }: { tracks: LegacyTrackStats[] }) {
  if (tracks.length === 0) return <p className="community-empty">Nothing imported from QueUp.</p>;
  return (
    <div className="community-table-wrap">
      <table className="community-table track-table legacy-table">
        <thead><tr><th>#</th><th>Track</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr></thead>
        <tbody>
          {tracks.map((entry, index) => (
            <tr key={`${entry.provider}:${entry.providerMediaId}`}>
              <td>{index + 1}</td>
              <td>
                <div className="history-track">
                  {entry.thumbnailUrl ? (
                    <img src={entry.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="history-art-empty"><ListMusic size={16} /></span>
                  )}
                  <div>
                    <TrackLink
                      provider={entry.provider}
                      providerMediaId={entry.providerMediaId}
                      title={entry.title}
                    />
                    <span>
                      <ProviderLink provider={entry.provider} url={entry.canonicalUrl} />
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
  );
}

/** The archive's requesters, by their QueUp names. No account is behind one. */
function LegacyJammerTable({ jammers }: { jammers: LegacyJammerStats[] }) {
  if (jammers.length === 0) return <p className="community-empty">Nothing imported from QueUp.</p>;
  return (
    <div className="community-table-wrap">
      <table className="community-table jammer-table legacy-table">
        <thead><tr><th>#</th><th>Jammer</th><th>Plays</th><th>Up</th><th>Down</th><th>Score</th></tr></thead>
        <tbody>
          {jammers.map((entry, index) => (
            <tr key={entry.requesterName}>
              <td>{index + 1}</td>
              <td className="legacy-requester">{entry.requesterName}</td>
              <td data-label="Plays">{entry.plays}</td>
              <td data-label="Up">{entry.upvotes}</td>
              <td data-label="Down">{entry.downvotes}</td>
              <td data-label="Score"><Score value={entry.score} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATS_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'jammers', label: 'Jammers' },
  { id: 'genres', label: 'Genres' },
] as const;

type StatsSection = (typeof STATS_SECTIONS)[number]['id'];

/** Which section is open, and which slice of time it is about. */
interface StatsState {
  section: StatsSection;
  year: number | null;
  month: number | null;
}

const STATS_START: StatsState = { section: 'overview', year: null, month: null };

const MONTH_NAMES = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, index, 1)),
  ),
);

function readStatsState(): StatsState {
  const params = new URLSearchParams(window.location.search);
  const section = params.get('section');
  const year = Number(params.get('year'));
  const month = Number(params.get('month'));
  return {
    section: STATS_SECTIONS.some((entry) => entry.id === section)
      ? (section as StatsSection)
      : 'overview',
    year: Number.isInteger(year) && year > 0 ? year : null,
    // A month on its own describes nothing, so it needs a year beside it.
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
  };
}

function statsQuery(state: StatsState): string {
  const params = new URLSearchParams();
  if (state.section !== 'overview') params.set('section', state.section);
  if (state.year) params.set('year', String(state.year));
  if (state.year && state.month) params.set('month', String(state.month));
  const query = params.toString();
  return query ? `?${query}` : window.location.pathname;
}

/** How the period reads in a sentence, for the heading under the title. */
function periodLabel(state: StatsState): string {
  if (!state.year) return 'All time';
  if (!state.month) return String(state.year);
  return `${MONTH_NAMES[state.month - 1]} ${state.year}`;
}

/**
 * Years across the top, and the months of whichever year is open underneath.
 *
 * Only periods the room actually has plays in are offered. A month picker full
 * of months nothing happened in invites clicking through empty pages, and the
 * archive starts partway through 2024, so several of them would be.
 */
function PeriodPicker({
  periods,
  state,
  onPeriod,
}: {
  periods: AvailablePeriod[];
  state: StatsState;
  onPeriod: (period: { year: number | null; month: number | null }) => void;
}) {
  if (periods.length === 0) return null;
  const months = periods.find((entry) => entry.year === state.year)?.months ?? [];

  return (
    <div className="stats-period">
      <div className="stats-period-row" role="group" aria-label="Year">
        <button
          type="button"
          className={state.year === null ? 'is-active' : undefined}
          aria-pressed={state.year === null}
          onClick={() => onPeriod({ year: null, month: null })}
        >
          All time
        </button>
        {periods.map((entry) => (
          <button
            key={entry.year}
            type="button"
            className={state.year === entry.year ? 'is-active' : undefined}
            aria-pressed={state.year === entry.year}
            onClick={() => onPeriod({ year: entry.year, month: null })}
          >
            {entry.year}
          </button>
        ))}
      </div>

      {state.year !== null && months.length > 0 && (
        <div className="stats-period-row stats-period-months" role="group" aria-label="Month">
          <button
            type="button"
            className={state.month === null ? 'is-active' : undefined}
            aria-pressed={state.month === null}
            onClick={() => onPeriod({ year: state.year, month: null })}
          >
            All year
          </button>
          {months.map((month) => (
            <button
              key={month}
              type="button"
              className={state.month === month ? 'is-active' : undefined}
              aria-pressed={state.month === month}
              onClick={() => onPeriod({ year: state.year, month })}
            >
              {MONTH_NAMES[month - 1]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewSection({ stats }: { stats: CommunityStats }) {
  return (
    <>
      <dl className="stat-strip">
        <div><dt>Listeners</dt><dd>{stats.totals.members}</dd></div>
        <div><dt>Tracks played</dt><dd>{stats.totals.tracksPlayed}</dd></div>
        <div><dt>Votes cast</dt><dd>{stats.totals.votes}</dd></div>
      </dl>

      {stats.legacy.totals.plays > 0 && (
        <dl className="stat-strip stat-strip-legacy">
          <div><dt>QueUp plays</dt><dd>{stats.legacy.totals.plays.toLocaleString()}</dd></div>
          <div><dt>QueUp tracks</dt><dd>{stats.legacy.totals.tracks.toLocaleString()}</dd></div>
          <div><dt>QueUp requesters</dt><dd>{stats.legacy.totals.people.toLocaleString()}</dd></div>
        </dl>
      )}

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
    </>
  );
}

function TracksSection({ stats }: { stats: CommunityStats }) {
  const [scope, setScope] = useState<StatsScope>('room');
  const hasArchive = stats.legacy.totals.plays > 0;

  return (
    <section className="community-section">
      <div className="community-section-heading">
        <h2>Top Played</h2>
        <span>Times a track reached the player, then its score</span>
      </div>
      <ScopeToggle scope={scope} hasArchive={hasArchive} onScope={setScope} />
      {scope === 'queup' ? (
        <LegacyTrackTable tracks={stats.legacy.tracks} />
      ) : stats.tracks.length ? (
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
                        <span className="history-track-title">
                          <TrackLink
                            provider={entry.media.provider}
                            providerMediaId={entry.media.providerMediaId}
                            title={entry.media.title}
                          />
                        </span>
                        <span>
                          <ProviderLink
                            provider={entry.media.provider}
                            url={entry.media.canonicalUrl}
                          />
                          {' · '}
                          <ArtistLink
                            provider={entry.media.provider}
                            providerArtistId={entry.media.providerArtistId}
                            artist={entry.media.artist}
                          />
                          {' · '}{formatDuration(entry.media.durationSeconds)}
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
      ) : <p className="community-empty">No tracks have played in that time.</p>}
    </section>
  );
}

function JammersSection({ stats }: { stats: CommunityStats }) {
  const [scope, setScope] = useState<StatsScope>('room');
  const hasArchive = stats.legacy.totals.plays > 0;

  return (
    <section className="community-section">
      <div className="community-section-heading"><h2>Top Jammers</h2><span>Score, then number of plays</span></div>
      <ScopeToggle scope={scope} hasArchive={hasArchive} onScope={setScope} />
      {scope === 'queup' ? (
        <LegacyJammerTable jammers={stats.legacy.jammers} />
      ) : stats.jammers.length ? (
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
      ) : <p className="community-empty">Nobody requested anything in that time.</p>}
    </section>
  );
}

/**
 * The stats page reads itself, because the period is part of the question and
 * changing it changes every number on the page. The section is not: switching
 * tabs shows something already fetched.
 */
function StatsView({ apiUrl }: { apiUrl: string }) {
  const [state, setState] = useState<StatsState>(STATS_START);
  const [ready, setReady] = useState(false);
  const [stats, setStats] = useState<CommunityStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = () => {
      setState(readStatsState());
      setReady(true);
    };
    fromUrl();
    window.addEventListener('popstate', fromUrl);
    return () => window.removeEventListener('popstate', fromUrl);
  }, []);

  const { year, month } = state;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const load = async () => {
      try {
        const query = new URLSearchParams();
        if (year) query.set('year', String(year));
        if (year && month) query.set('month', String(month));
        const response = await fetch(`${apiUrl}/api/stats?${query}`, { credentials: 'include' });
        if (!response.ok) throw new Error('The stats could not be read.');
        const answer = (await response.json()) as CommunityStats;
        if (cancelled) return;
        setStats(answer);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'The stats could not be read.');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, ready, year, month]);

  const go = (change: Partial<StatsState>) => {
    setState((current) => {
      const next = { ...current, ...change };
      window.history.pushState(null, '', statsQuery(next));
      return next;
    });
  };

  return (
    <>
      <header className="community-title">
        <h1>Stats</h1>
        <p>{periodLabel(state)} · votes received on tracks that reached the player.</p>
      </header>

      {stats && (
        <PeriodPicker
          periods={stats.periods}
          state={state}
          onPeriod={(period) => go(period)}
        />
      )}

      <div className="history-tabs" role="tablist" aria-label="Which stats">
        {STATS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            id={`stats-tab-${section.id}`}
            aria-selected={state.section === section.id}
            aria-controls="stats-panel"
            className={state.section === section.id ? 'is-active' : undefined}
            onClick={() => go({ section: section.id })}
          >
            {section.label}
          </button>
        ))}
      </div>

      <div id="stats-panel" role="tabpanel" aria-labelledby={`stats-tab-${state.section}`}>
        {error ? (
          <p className="community-error" role="alert">{error}</p>
        ) : !stats ? (
          <p className="community-loading">Loading...</p>
        ) : state.section === 'overview' ? (
          <OverviewSection stats={stats} />
        ) : state.section === 'tracks' ? (
          <TracksSection stats={stats} />
        ) : state.section === 'jammers' ? (
          <JammersSection stats={stats} />
        ) : (
          <GenreSection genres={stats.genres} />
        )}
      </div>
    </>
  );
}

const HISTORY_PAGE = 50;

type HistoryTab = 'room' | 'queup';

/**
 * Which history, what was searched for, and which page of it. It lives in the
 * address bar rather than only in the component, so that what somebody is
 * looking at can be sent to somebody else — which is also why the histories are
 * paged by number rather than walked by a cursor.
 */
interface HistoryState {
  tab: HistoryTab;
  search: string;
  genre: string;
  page: number;
}

const START: HistoryState = { tab: 'room', search: '', genre: '', page: 1 };

function readHistoryState(): HistoryState {
  const params = new URLSearchParams(window.location.search);
  const page = Number(params.get('page'));
  return {
    tab: params.get('tab') === 'queup' ? 'queup' : 'room',
    search: params.get('q')?.trim() ?? '',
    genre: params.get('genre')?.trim() ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** Only what differs from the default, so an unfiltered history has a clean URL. */
function historyQuery(state: HistoryState): string {
  const params = new URLSearchParams();
  if (state.tab === 'queup') params.set('tab', 'queup');
  if (state.search) params.set('q', state.search);
  if (state.genre) params.set('genre', state.genre);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `?${query}` : window.location.pathname;
}

interface HistoryFeed<Entry> {
  entries: Entry[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Rewrites what is on screen without re-reading the page it came from. */
  update: (change: (entries: Entry[]) => Entry[]) => void;
}

interface FeedPage<Entry> {
  entries: Entry[];
  total: number;
}

/**
 * One history, one page at a time. Both of them answer the same shape, so the
 * room's own plays and the QueUp archive are read by the same hook and behave
 * the same way: newest first, a page number, and a search that narrows the list
 * and the count together.
 */
function useHistoryFeed<Entry>(
  apiUrl: string,
  path: string,
  search: string,
  genre: string,
  page: number,
  unreadable: string,
  ready: boolean,
): HistoryFeed<Entry> {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Nothing is worth fetching until the address bar has been read, or the
    // first thing every shared link does is load the wrong page.
    if (!ready) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const query = new URLSearchParams({ limit: String(HISTORY_PAGE), page: String(page) });
        if (search) query.set('q', search);
        if (genre) query.set('genre', genre);
        const response = await fetch(`${apiUrl}${path}?${query}`, { credentials: 'include' });
        if (!response.ok) throw new Error(unreadable);
        const answer = (await response.json()) as FeedPage<Entry>;
        if (cancelled) return;
        setEntries(answer.entries);
        setTotal(answer.total);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : unreadable);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, path, search, genre, page, unreadable, ready]);

  return { entries, total, loading, error, update: (change) => setEntries(change) };
}

/**
 * The pages worth offering out of the hundreds there can be: the ends, a few
 * either side of where the reader is, and a gap for everything between.
 */
function pageWindow(page: number, pageCount: number): (number | 'gap')[] {
  const wanted = new Set([1, pageCount]);
  for (let nearby = page - 2; nearby <= page + 2; nearby += 1) {
    if (nearby >= 1 && nearby <= pageCount) wanted.add(nearby);
  }

  const shown: (number | 'gap')[] = [];
  let previous = 0;
  for (const number of [...wanted].sort((left, right) => left - right)) {
    if (previous && number - previous > 1) shown.push('gap');
    shown.push(number);
    previous = number;
  }
  return shown;
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  if (pageCount < 2) return null;
  const first = (page - 1) * HISTORY_PAGE + 1;
  const last = Math.min(page * HISTORY_PAGE, total);

  return (
    <nav className="history-pager" aria-label="Pages">
      <p>
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </p>
      <div>
        <button
          type="button"
          aria-label="Previous page"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        {pageWindow(page, pageCount).map((number, index) =>
          number === 'gap' ? (
            <span key={`gap-${index}`} aria-hidden="true">…</span>
          ) : (
            <button
              key={number}
              type="button"
              className={number === page ? 'is-current' : undefined}
              aria-current={number === page ? 'page' : undefined}
              aria-label={`Page ${number}`}
              onClick={() => onPage(number)}
            >
              {number.toLocaleString()}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label="Next page"
          disabled={page === pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </nav>
  );
}

/**
 * What the room played on QueUp, before this site existed. It reads differently
 * from the room's own history on purpose: the names are QueUp names with no
 * profile behind them, the votes were cast there, and none of it counts towards
 * anything here.
 *
 * Saving and requesting are the exceptions. The archive knows a provider and an
 * id and nothing else, so the first time anyone reaches for a track the
 * provider is asked what it is; from then on it is an ordinary track.
 */
function LegacyHistory({
  archive,
  library,
  onQueue,
  queueing,
  onSelectGenre,
  empty,
}: {
  archive: HistoryFeed<LegacyPlay>;
  library: PlaylistLibraryController;
  onQueue: (entry: LegacyPlay) => void;
  queueing: string | null;
  onSelectGenre: (genre: string) => void;
  empty: string;
}) {
  if (archive.error) {
    return <p className="community-error" role="alert">{archive.error}</p>;
  }
  if (archive.entries.length === 0) {
    return <p className="community-empty">{empty}</p>;
  }

  return (
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
            {archive.entries.map((entry) => (
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
                        <TrackLink
                          provider={entry.provider}
                          providerMediaId={entry.providerMediaId}
                          title={entry.title}
                        />
                        {library.signedIn && (
                          <>
                            <SaveToPlaylistButton
                              target={
                                entry.mediaId
                                  ? { kind: 'media', mediaId: entry.mediaId, title: entry.title }
                                  : { kind: 'legacy', sourceId: entry.id, title: entry.title }
                              }
                              library={library}
                              compact
                              onResolved={(mediaId) =>
                                archive.update((current) =>
                                  current.map((play) =>
                                    play.id === entry.id ? { ...play, mediaId } : play,
                                  ),
                                )
                              }
                            />
                            <QueueButton
                              title={entry.title}
                              busy={queueing === entry.id}
                              onQueue={() => onQueue(entry)}
                            />
                          </>
                        )}
                      </span>
                      <span>
                        <ProviderLink provider={entry.provider} url={entry.canonicalUrl} />
                        {' · '}{formatDuration(entry.durationSeconds)}
                        <GenreTags genres={entry.genres} onSelect={onSelectGenre} />
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
      <GenreCredit shown={archive.entries.some((entry) => entry.genres)} />
    </>
  );
}

function HistoryView({ apiUrl }: { apiUrl: string }) {
  const [state, setState] = useState<HistoryState>(START);
  // The address bar is only readable once this is running in a browser, and the
  // page is server-rendered before that.
  const [ready, setReady] = useState(false);
  const [typed, setTyped] = useState('');
  const [queueing, setQueueing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = () => {
      const read = readHistoryState();
      setState(read);
      setTyped(read.search);
      setReady(true);
    };
    fromUrl();
    // Back and forward move between pages and searches, as they would on any
    // other list somebody is reading.
    window.addEventListener('popstate', fromUrl);
    return () => window.removeEventListener('popstate', fromUrl);
  }, []);

  /** Every change to what is shown goes through here, and through the URL. */
  const go = (change: Partial<HistoryState>) => {
    setState((current) => {
      // A different tab or a different search is a different list, so it starts
      // at the top of it rather than at whatever page number was left over.
      const next = { ...current, page: 1, ...change };
      window.history.pushState(null, '', historyQuery(next));
      return next;
    });
  };

  const room = useHistoryFeed<HistoryEntry>(
    apiUrl,
    '/api/history',
    state.search,
    state.genre,
    state.tab === 'room' ? state.page : 1,
    'The history could not be read.',
    ready,
  );
  const archive = useHistoryFeed<LegacyPlay>(
    apiUrl,
    '/api/history/legacy',
    state.search,
    state.genre,
    state.tab === 'queup' ? state.page : 1,
    'The QueUp archive could not be read.',
    ready,
  );

  // One library across both tabs, so a track saved out of the archive shows as
  // saved in the room's own history too.
  const library = usePlaylistLibrary(apiUrl, [
    ...room.entries.map(({ media }) => media.id),
    ...archive.entries.flatMap((entry) => (entry.mediaId ? [entry.mediaId] : [])),
  ]);

  // A room nobody has imported into has no second list, and offering an empty
  // tab would be explaining an absence rather than showing anything. A search
  // the archive does not match still leaves the tab there, saying zero.
  const narrowed = Boolean(state.search || state.genre);
  const hasArchive = archive.total > 0 || narrowed;
  const active = hasArchive ? state.tab : 'room';
  const showing = active === 'room' ? room : archive;
  const total = showing.total;

  // A shared link can name a page that a later search no longer reaches. Only
  // once the count has actually arrived, or this would send every link to page
  // one on the way past zero.
  useEffect(() => {
    if (showing.loading) return;
    const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE));
    if (state.page > pageCount) go({ page: pageCount });
  }, [showing.loading, total, state.page]);

  /** Requesting a track from either history, through the room's ordinary path. */
  async function queue(id: string, title: string, request: { path: string; body?: unknown }) {
    setQueueing(id);
    setNotice(null);
    try {
      const response = await fetch(`${apiUrl}${request.path}`, {
        method: 'POST',
        credentials: 'include',
        headers: request.body ? { 'Content-Type': 'application/json' } : undefined,
        body: request.body ? JSON.stringify(request.body) : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((payload as ApiErrorBody | null)?.error.message ?? 'The room refused that track.');
      }
      setNotice(`Added "${title}" to your queue.`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'The room refused that track.');
    } finally {
      setQueueing(null);
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    go({ search: typed.trim() });
  }

  return (
    <>
      <header className="community-title">
        <h1>History</h1>
        <p>
          {active === 'room'
            ? 'The latest completed and skipped tracks, newest first.'
            : 'What the room played on QueUp before this one existed. The names are QueUp names.'}
        </p>
      </header>

      <form className="history-search" onSubmit={submitSearch}>
        <input
          value={typed}
          maxLength={80}
          placeholder="Search by track, artist, or who requested it"
          aria-label="Search the history"
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
        <button type="submit"><Search size={15} /> Search</button>
        {state.search && (
          <button
            type="button"
            onClick={() => {
              setTyped('');
              go({ search: '' });
            }}
          >
            Clear
          </button>
        )}
      </form>

      {state.genre && (
        <p className="history-genre-filter">
          Only <strong>{state.genre}</strong>
          <button type="button" aria-label={`Stop showing only ${state.genre}`} onClick={() => go({ genre: '' })}>
            <X size={13} />
          </button>
        </p>
      )}

      {hasArchive && (
        <div className="history-tabs" role="tablist" aria-label="Which history">
          <button
            type="button"
            role="tab"
            id="history-tab-room"
            aria-selected={active === 'room'}
            aria-controls="history-panel-room"
            className={active === 'room' ? 'is-active' : undefined}
            onClick={() => go({ tab: 'room' })}
          >
            DGG Radio <small>{room.total.toLocaleString()}</small>
          </button>
          <button
            type="button"
            role="tab"
            id="history-tab-queup"
            aria-selected={active === 'queup'}
            aria-controls="history-panel-queup"
            className={active === 'queup' ? 'is-active' : undefined}
            onClick={() => go({ tab: 'queup' })}
          >
            QueUp <small>{archive.total.toLocaleString()}</small>
          </button>
        </div>
      )}

      {library.error && (
        <p className="community-error" role="alert">
          {library.error} Saving to a playlist is unavailable.
        </p>
      )}
      {notice && <p className="history-notice" role="status">{notice}</p>}

      {active === 'room' ? (
        <section
          className="community-section history-section"
          role={hasArchive ? 'tabpanel' : undefined}
          id="history-panel-room"
          aria-labelledby={hasArchive ? 'history-tab-room' : undefined}
        >
          {room.error ? (
            <p className="community-error" role="alert">{room.error}</p>
          ) : (
            <>
              <HistoryTable
                entries={room.entries}
                showRequester
                library={library}
                queueing={queueing}
                onSelectGenre={(genre) => go({ genre })}
                empty={narrowed ? 'No track this room has played matches that.' : undefined}
                onQueue={(entry) =>
                  void queue(entry.id, entry.media.title, {
                    path: '/api/queue',
                    body: { url: entry.media.canonicalUrl },
                  })
                }
              />
              <GenreCredit shown={room.entries.some((entry) => entry.genres)} />
            </>
          )}
        </section>
      ) : (
        <section
          className="community-section history-section legacy-section"
          role="tabpanel"
          id="history-panel-queup"
          aria-labelledby="history-tab-queup"
        >
          <LegacyHistory
            archive={archive}
            library={library}
            queueing={queueing}
            onSelectGenre={(genre) => go({ genre })}
            empty={narrowed ? 'No archived play matches that.' : 'Nothing has been imported from QueUp.'}
            onQueue={(entry) =>
              void queue(entry.id, entry.title, { path: `/api/queue/legacy/${encodeURIComponent(entry.id)}` })
            }
          />
        </section>
      )}

      <Pager page={state.page} total={total} onPage={(page) => go({ page })} />
    </>
  );
}

export default function CommunityPage({ apiUrl, view }: CommunityPageProps) {
  const [data, setData] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // History and stats read themselves: each has filters of its own that
    // change what is fetched, so one request here would be the wrong one.
    if (view !== 'profile') return;
    let cancelled = false;
    const load = async () => {
      try {
        const username = decodeURIComponent(
          window.location.pathname.split('/').filter(Boolean).at(-1) ?? '',
        );
        if (!username || username.toLowerCase() === 'profile') {
          throw new Error('Choose a listener from stats or history.');
        }
        const endpoint = `/api/profiles/${encodeURIComponent(username)}`;

        const response = await fetch(`${apiUrl}${endpoint}`, { credentials: 'include' });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as ApiErrorBody | null;
          throw new Error(body?.error.message ?? 'The page could not be loaded.');
        }
        const next = (await response.json()) as UserProfile;
        if (!cancelled) {
          setData(next);
          document.title = `${next.user.username} · DGG Radio`;
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
        {view === 'history' ? (
          <HistoryView apiUrl={apiUrl} />
        ) : view === 'stats' ? (
          <StatsView apiUrl={apiUrl} />
        ) : error ? (
          <div className="community-error" role="alert">{error}</div>
        ) : !data ? (
          <p className="community-loading">Loading...</p>
        ) : (
          <ProfileView profile={data as UserProfile} apiUrl={apiUrl} />
        )}
      </main>
      <footer className="community-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
