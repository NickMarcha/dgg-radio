import type { TrackGenre } from '../shared/contracts';
import { getEnv } from './env';
import { normalize } from './musicbrainz';

/**
 * Asking Discogs about a track that is playing now.
 *
 * The stored genres come from the monthly dump, joined exactly on the YouTube
 * video id Discogs embeds in its masters. The API cannot be queried by video id
 * at all, so this path has to search by artist and title instead, which is
 * fuzzy in a way the dump join never is. That was measured rather than assumed:
 * on the 50 sampled tracks the dump missed, it answered 26, all 26 credited to
 * the right artist and none to the wrong one. It fails closed, which is what
 * makes it safe to consult for a track somebody is listening to.
 *
 * What comes back is stored in `track_genres` beside every other source. That
 * is a decision rather than an oversight: the Discogs API terms restrict how
 * long their content may be kept, and the room's operator has confirmed
 * permission to keep it. The bulk of the table still comes from the CC0 monthly
 * dump, which carries no such restriction.
 *
 * The credentials raise the rate limit from 25 requests a minute to 60. Without
 * them this still works, more slowly, so they are optional.
 */

const ENDPOINT = 'https://api.discogs.com/database/search';
const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
/** Comfortably inside 60 a minute, and inside 25 a minute if unauthenticated. */
const REQUEST_SPACING_MS = 2_500;

let nextSlot = Promise.resolve();

function waitForSlot(): Promise<void> {
  const waited = nextSlot;
  nextSlot = waited.then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return waited;
}

interface SearchResult {
  id?: number;
  title?: string;
  genre?: string[];
  style?: string[];
}

/**
 * Search titles read `Artist - Release`, so the credited artist is the part
 * before the first dash. It is the only precision check available without
 * spending a second request on every result.
 */
function creditedArtist(title: string | undefined): string {
  return title?.split(' - ')[0] ?? '';
}

function artistMatches(expected: string, result: SearchResult): boolean {
  const credited = normalize(creditedArtist(result.title));
  const wanted = normalize(expected);
  if (!credited || !wanted) return false;
  return credited.includes(wanted) || wanted.includes(credited);
}

/**
 * What Discogs says a track is, or null. Null covers every uncertain case:
 * Discogs knowing nothing, and Discogs answering with a record by somebody
 * else. A wrong genre is worse than none.
 */
export async function searchGenre(artist: string, title: string): Promise<TrackGenre | null> {
  const env = getEnv();
  const endpoint = new URL(ENDPOINT);
  endpoint.searchParams.set('artist', artist);
  endpoint.searchParams.set('track', title);
  endpoint.searchParams.set('type', 'master');
  endpoint.searchParams.set('per_page', '5');

  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (env.DISCOGS_CONSUMER_KEY && env.DISCOGS_CONSUMER_SECRET) {
    headers.Authorization = `Discogs key=${env.DISCOGS_CONSUMER_KEY}, secret=${env.DISCOGS_CONSUMER_SECRET}`;
  }

  await waitForSlot();
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;

  const answer = (await response.json()) as { results?: SearchResult[] };
  const top = answer.results?.[0];
  if (!top || !artistMatches(artist, top)) return null;

  const genres = top.genre ?? [];
  const styles = top.style ?? [];
  if (genres.length === 0 && styles.length === 0) return null;

  return {
    source: 'discogs',
    level: 'master',
    genres,
    styles,
    url: top.id ? `https://www.discogs.com/master/${top.id}` : null,
    // A search answers about one release, so there is no second one to disagree.
    ambiguous: false,
  };
}
