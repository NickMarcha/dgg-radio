import { ArrowUpRight } from 'lucide-react';
import type { GenreLevel, TrackGenre, TrackGenres } from '../shared/contracts';
import './TrackGenres.css';

/** What the genre is actually about, said plainly enough to read in a tooltip. */
const GENRE_LEVELS: Record<GenreLevel, string> = {
  recording: 'this recording',
  release_group: 'the release it came out on',
  master: 'the Discogs release it appears on',
  artist: "the artist's whole catalogue, not this track",
};

/** The three that fit in a row. The rest are named in the tooltip. */
function shownNames(entry: TrackGenre): string[] {
  return [...entry.genres, ...entry.styles].slice(0, 3);
}

function describeGenre(entry: TrackGenre): string {
  const source = entry.source === 'discogs' ? 'Discogs' : 'MusicBrainz';
  const words = [entry.genres.join(', '), entry.styles.join(', ')].filter(Boolean).join(' — ');
  const doubt = entry.ambiguous
    ? ' Discogs attaches this video to releases that disagree about it, so it may be wrong.'
    : '';
  return `${source}: ${words}. Describes ${GENRE_LEVELS[entry.level]}.${doubt}`;
}

/**
 * What a track is, in each source's own words.
 *
 * The two vocabularies are shown side by side and never merged: Discogs has
 * about fifteen broad genres plus a sharper style list, MusicBrainz a
 * folksonomy of hundreds, and squashing them together would invent both
 * agreement and conflict. Seeing both is also the only honest way to show that
 * two sources independently said the same thing.
 *
 * A genre that is really about the artist rather than the track says so on the
 * row. Every Boards of Canada track carries the same artist genres whichever
 * one played, and presenting that as a description of the track would be a
 * quiet lie.
 *
 * Where `onSelect` is given each name narrows the list to it. The link out to
 * the source stays either way, because both licences ask for it.
 */
export default function GenreTags({
  genres,
  onSelect,
}: {
  genres: TrackGenres | null;
  onSelect?: (genre: string) => void;
}) {
  if (!genres) return null;
  return (
    <span
      className={`track-genres${genres.corroborated ? ' is-corroborated' : ''}`}
      title={genres.corroborated ? 'Both sources labelled this track independently.' : undefined}
    >
      {genres.entries.map((entry) => (
        <span
          key={entry.source}
          className={`track-genre track-genre-${entry.source}${entry.level === 'artist' ? ' is-artist' : ''}`}
        >
          {entry.level === 'artist' && <span className="track-genre-level">artist</span>}
          {shownNames(entry).map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              {onSelect ? (
                <button
                  type="button"
                  className="track-genre-name"
                  title={`Show only ${name}`}
                  onClick={() => onSelect(name)}
                >
                  {name}
                </button>
              ) : (
                <span className="track-genre-name">{name}</span>
              )}
            </span>
          ))}
          {entry.ambiguous && (
            <span className="track-genre-doubt" title={describeGenre(entry)}>?</span>
          )}
          {entry.url && (
            <a
              className="track-genre-source"
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              title={describeGenre(entry)}
              aria-label={`${entry.source === 'discogs' ? 'Discogs' : 'MusicBrainz'} entry for this track`}
            >
              <ArrowUpRight size={11} />
            </a>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * Both licences ask for this, and it is shown once under a list rather than on
 * every row. MusicBrainz genre is CC BY-NC-SA supplementary data; the Discogs
 * genres stored here come from the CC0 monthly dump rather than from its API.
 */
export function GenreCredit({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <p className="genre-credit">
      Genres from{' '}
      <a href="https://musicbrainz.org" target="_blank" rel="noreferrer">MusicBrainz</a>{' '}
      (CC BY-NC-SA) and the{' '}
      <a href="https://data.discogs.com" target="_blank" rel="noreferrer">Discogs monthly data dump</a>{' '}
      (CC0). The two use different vocabularies and are never merged.
    </p>
  );
}
