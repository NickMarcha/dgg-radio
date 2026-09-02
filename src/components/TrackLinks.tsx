import type { MediaProvider } from '../shared/contracts';
import './TrackLinks.css';

/**
 * The room's own pages for a track and for whoever published it, and the way
 * out to the provider.
 *
 * Both paths are keyed by the provider's own id rather than by a `media` row,
 * for the same reason genre is: most of what the room knows about is the QueUp
 * archive, and none of that has a row here.
 */
export function trackPath(provider: MediaProvider, providerMediaId: string): string {
  return `/track/${provider}/${encodeURIComponent(providerMediaId)}`;
}

export function artistPath(provider: MediaProvider, providerArtistId: string): string {
  return `/artist/${provider}/${encodeURIComponent(providerArtistId)}`;
}

export function providerName(provider: MediaProvider): string {
  return provider === 'youtube' ? 'YouTube' : 'SoundCloud';
}

/** A title, going to what the room knows about it rather than out to YouTube. */
export function TrackLink({
  provider,
  providerMediaId,
  title,
}: {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
}) {
  return <a href={trackPath(provider, providerMediaId)}>{title}</a>;
}

/**
 * Where the track actually lives. Two letters in the provider's own colour,
 * because this sits on every row of every list beside a title that wants the
 * room, and the colour already says which service it is.
 */
export function ProviderLink({
  provider,
  url,
}: {
  provider: MediaProvider;
  url: string | null;
}) {
  const short = provider === 'youtube' ? 'YT' : 'SC';
  const full = providerName(provider);
  if (!url) {
    // QueUp stored SoundCloud tracks by a numeric id, which names no page.
    return <span className={`provider-badge provider-${provider}`} title={full}>{short}</span>;
  }
  return (
    <a
      className={`provider-badge provider-${provider}`}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open on ${full}`}
    >
      {short}
    </a>
  );
}

/** The channel or account, where the room knows which one it was. */
export function ArtistLink({
  provider,
  providerArtistId,
  artist,
}: {
  provider: MediaProvider;
  providerArtistId: string | null;
  artist: string;
}) {
  if (!providerArtistId) return <>{artist}</>;
  return <a className="artist-link" href={artistPath(provider, providerArtistId)}>{artist}</a>;
}
