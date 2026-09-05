import { ListMusic } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  ApiErrorBody,
  ArtistDetail,
  MediaProvider,
  TrackDetail,
  TrackPlay,
  TrackSummary,
} from '../shared/contracts';
import { userClass } from './flair';
import SiteHeader from './SiteHeader';
import SiteNav from './SiteNav';
import SaveToPlaylistButton from './SaveToPlaylistButton';
import GenreTags, { GenreCredit } from './TrackGenres';
import { ArtistLink, ProviderLink, providerName, trackPath } from './TrackLinks';
import { usePlaylistLibrary } from './usePlaylistLibrary';
// The page frame, the tables and the stat strip are the community pages' own,
// and these are two more of them. Only what is particular to a track or an
// artist lives in the stylesheet below.
import './CommunityPage.css';
import './CataloguePage.css';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dayFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function profileUrl(username: string): string {
  return `/profile/${encodeURIComponent(username)}`;
}

/**
 * The provider and its id, out of the address bar.
 *
 * These pages are prerendered and served for any path under them, the same way
 * `/profile` is, so the path is what carries which track or artist is wanted.
 */
function fromPath(): { provider: MediaProvider; id: string } | null {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const [, provider, id] = parts;
  if ((provider !== 'youtube' && provider !== 'soundcloud') || !id) return null;
  return { provider, id: decodeURIComponent(id) };
}

/** One history's worth of plays. The two are never merged; see `catalogue.ts`. */
function PlayTable({
  plays,
  title,
  note,
}: {
  plays: TrackPlay[];
  title: string;
  note: string;
}) {
  if (plays.length === 0) return null;
  return (
    <section className="catalogue-section">
      <div className="community-section-heading">
        <h2>{title}</h2>
        <span>{note}</span>
      </div>
      <div className="community-table-wrap">
        <table className="community-table history-table">
          <thead>
            <tr><th>Requested by</th><th>Played</th><th>Votes</th><th>Result</th></tr>
          </thead>
          <tbody>
            {plays.map((play) => (
              <tr key={`${play.playedAt}-${play.requesterName}`}>
                <td>
                  {play.requester ? (
                    <a
                      className={userClass(play.requester, 'profile-link')}
                      href={profileUrl(play.requester.username)}
                    >
                      {play.requester.username}
                    </a>
                  ) : (
                    <span className="legacy-requester">{play.requesterName}</span>
                  )}
                </td>
                <td data-label="Played">
                  <time dateTime={play.playedAt}>{dateFormatter.format(new Date(play.playedAt))}</time>
                </td>
                <td data-label="Votes">
                  <span className="vote-up">+{play.upvotes}</span>{' '}
                  <span className="vote-down">-{play.downvotes}</span>
                </td>
                <td data-label="Result" className={`history-status status-${play.status}`}>
                  {play.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrackGrid({
  tracks,
  title,
  note,
}: {
  tracks: TrackSummary[];
  title: string;
  note: string;
}) {
  if (tracks.length === 0) return null;
  return (
    <section className="catalogue-section">
      <div className="community-section-heading">
        <h2>{title}</h2>
        <span>{note}</span>
      </div>
      <ul className="catalogue-grid">
        {tracks.map((track) => (
          <li key={`${track.provider}:${track.providerMediaId}`}>
            <a href={trackPath(track.provider, track.providerMediaId)}>
              {track.thumbnailUrl ? (
                <img src={track.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span className="catalogue-art"><ListMusic size={18} /></span>
              )}
              <span className="catalogue-grid-title">{track.title}</span>
            </a>
            <span className="catalogue-grid-plays">
              {track.plays.toLocaleString()} {track.plays === 1 ? 'play' : 'plays'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TrackView({ track, apiUrl }: { track: TrackDetail; apiUrl: string }) {
  const library = usePlaylistLibrary(apiUrl, track.mediaId ? [track.mediaId] : []);
  const { totals } = track;
  const plays = totals.roomPlays + totals.archivePlays;

  return (
    <>
      <header className="catalogue-heading">
        {track.thumbnailUrl ? (
          <img src={track.thumbnailUrl} alt="" />
        ) : (
          <span className="catalogue-art catalogue-art-large"><ListMusic size={28} /></span>
        )}
        <div>
          <h1>{track.title}</h1>
          <p>
            <ProviderLink provider={track.provider} url={track.canonicalUrl} />
            {track.artist && (
              <>
                {' · '}
                <ArtistLink
                  provider={track.provider}
                  providerArtistId={track.providerArtistId}
                  artist={track.artist}
                />
              </>
            )}
            {track.durationSeconds !== null && <>{' · '}{formatDuration(track.durationSeconds)}</>}
          </p>
          {track.genres && (
            <p className="catalogue-genres">
              <GenreTags genres={track.genres} />
            </p>
          )}
          {library.signedIn && track.mediaId && (
            <div className="catalogue-actions">
              <SaveToPlaylistButton
                target={{ kind: 'media', mediaId: track.mediaId, title: track.title }}
                library={library}
              />
            </div>
          )}
        </div>
      </header>

      <dl className="stat-strip catalogue-stats">
        <div><dt>Plays</dt><dd>{plays.toLocaleString()}</dd></div>
        <div><dt>In this room</dt><dd>{totals.roomPlays.toLocaleString()}</dd></div>
        <div><dt>On QueUp</dt><dd>{totals.archivePlays.toLocaleString()}</dd></div>
        <div><dt>Votes</dt><dd>+{totals.upvotes} / -{totals.downvotes}</dd></div>
      </dl>

      {totals.firstPlayed && (
        <p className="catalogue-span">
          First played {dayFormatter.format(new Date(totals.firstPlayed))}
          {totals.lastPlayed && totals.lastPlayed !== totals.firstPlayed && (
            <>, most recently {dayFormatter.format(new Date(totals.lastPlayed))}</>
          )}
          .
        </p>
      )}

      <PlayTable
        plays={track.roomPlays}
        title="In this room"
        note={
          totals.roomPlays > track.roomPlays.length
            ? `The last ${track.roomPlays.length} of ${totals.roomPlays.toLocaleString()}`
            : 'Newest first'
        }
      />
      <PlayTable
        plays={track.archivePlays}
        title="On QueUp"
        note={
          totals.archivePlays > track.archivePlays.length
            ? `The last ${track.archivePlays.length} of ${totals.archivePlays.toLocaleString()} · names are QueUp names`
            : 'Names are QueUp names'
        }
      />

      <TrackGrid
        tracks={track.related.byArtist}
        title={`More from this ${track.provider === 'youtube' ? 'channel' : 'account'}`}
        note="By plays across both histories"
      />
      <TrackGrid
        tracks={track.related.byGenre}
        title="More like this"
        note="Sharing a genre, from either history"
      />
      <GenreCredit shown={Boolean(track.genres)} />
    </>
  );
}

function ArtistView({ artist }: { artist: ArtistDetail }) {
  const { totals } = artist;
  return (
    <>
      <header className="catalogue-heading">
        <div>
          <h1>{artist.name}</h1>
          <p>
            {providerName(artist.provider)}
            {artist.genres.length > 0 && (
              <>
                {' · '}
                {artist.genres.slice(0, 4).map((genre) => genre.name).join(', ')}
              </>
            )}
          </p>
        </div>
      </header>

      <dl className="stat-strip">
        <div><dt>Tracks</dt><dd>{totals.tracks.toLocaleString()}</dd></div>
        <div><dt>Plays here</dt><dd>{totals.roomPlays.toLocaleString()}</dd></div>
        <div><dt>Plays on QueUp</dt><dd>{totals.archivePlays.toLocaleString()}</dd></div>
      </dl>

      <p className="catalogue-span">
        Only tracks this room has a row for can be attributed to anyone: the QueUp archive
        recorded who requested a play and never who made the track.
      </p>

      <section className="catalogue-section">
        <div className="community-section-heading">
          <h2>Tracks</h2>
          <span>Most played first, both histories counted</span>
        </div>
        <div className="community-table-wrap">
          <table className="community-table track-table">
            <thead>
              <tr><th>#</th><th>Track</th><th>Here</th><th>QueUp</th></tr>
            </thead>
            <tbody>
              {artist.tracks.map((track, index) => (
                <tr key={track.providerMediaId}>
                  <td>{index + 1}</td>
                  <td>
                    <div className="history-track">
                      {track.thumbnailUrl ? (
                        <img src={track.thumbnailUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="history-art-empty"><ListMusic size={16} /></span>
                      )}
                      <div>
                        <a href={trackPath(track.provider, track.providerMediaId)}>{track.title}</a>
                      </div>
                    </div>
                  </td>
                  <td data-label="Here">{track.roomPlays}</td>
                  <td data-label="QueUp">{track.archivePlays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export default function CataloguePage({
  apiUrl,
  kind,
}: {
  apiUrl: string;
  kind: 'track' | 'artist';
}) {
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const wanted = fromPath();
      if (!wanted) {
        setError('That address does not name a track.');
        return;
      }
      const path =
        kind === 'track'
          ? `/api/tracks/${wanted.provider}/${encodeURIComponent(wanted.id)}`
          : `/api/artists/${wanted.provider}/${encodeURIComponent(wanted.id)}`;
      try {
        const response = await fetch(`${apiUrl}${path}`, { credentials: 'include' });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
          throw new Error(body?.error.message ?? 'That page could not be loaded.');
        }
        const answer = await response.json();
        if (cancelled) return;
        if (kind === 'track') {
          setTrack(answer as TrackDetail);
          document.title = `${(answer as TrackDetail).title} · DGG Radio`;
        } else {
          setArtist(answer as ArtistDetail);
          document.title = `${(answer as ArtistDetail).name} · DGG Radio`;
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'That page could not be loaded.');
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, kind]);

  return (
    <div className="community-app">
      <SiteHeader apiUrl={apiUrl} />
      <SiteNav />
      <main className="community-main">
        {error ? (
          <div className="community-error" role="alert">{error}</div>
        ) : track ? (
          <TrackView track={track} apiUrl={apiUrl} />
        ) : artist ? (
          <ArtistView artist={artist} />
        ) : (
          <p className="community-loading">Loading...</p>
        )}
      </main>
      <footer className="community-footer">
        Vibed by StrawWaffle <img className="footer-charm" src="/YeeCharm.gif" alt="" />
      </footer>
    </div>
  );
}
