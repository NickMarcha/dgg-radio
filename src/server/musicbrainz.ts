import type { GenreLevel } from '../shared/contracts';

/**
 * Identifying a track in MusicBrainz and reading what it is.
 *
 * Two things about this were learned the hard way and are worth stating here.
 *
 * Genre is not on the recording, which is the obvious place to look. Of 72
 * accepted recordings it was on the recording for 14, on the release group for
 * 43 and on the artist for 59. So this asks all three and records which one
 * answered, because artist genre is the most populated and the least useful:
 * every Boards of Canada track inherits `ambient / ambient techno / downtempo`
 * regardless of which track played.
 *
 * The **search** endpoint never returns genres, whatever `inc` is asked for.
 * They arrive only from a lookup. An earlier measurement read genres off search
 * results, got empty arrays, and reported that MusicBrainz had no genres at
 * all.
 *
 * MusicBrainz allows one request a second per source IP. Everything here goes
 * through one queue that spaces requests wider than that and backs off when
 * asked to, because being rate limited off a free service the room does not pay
 * for is nobody's fault but this code's.
 */

const ENDPOINT = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
/** One a second is the published limit; this leaves room for clock differences. */
const REQUEST_SPACING_MS = 1_200;
const MAX_ATTEMPTS = 5;
const SEARCH_LIMIT = 5;

export class MusicBrainzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusicBrainzError';
  }
}

let nextSlot = Promise.resolve();

/** Serialises every request through one queue, whoever asked for it. */
function waitForSlot(): Promise<void> {
  const waited = nextSlot;
  nextSlot = waited.then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return waited;
}

function retryDelay(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.max(header * 1_000, 2_000);
  return 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
}

async function request<Answer>(endpoint: URL): Promise<Answer> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await waitForSlot();
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return (await response.json()) as Answer;
    if (response.status !== 429 && response.status !== 503) {
      throw new MusicBrainzError(`MusicBrainz answered ${response.status} for ${endpoint.pathname}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
  }
  throw new MusicBrainzError(`MusicBrainz kept refusing ${endpoint.pathname}`);
}

interface NamedThing {
  name?: string;
}

interface ArtistCredit {
  name?: string;
  joinphrase?: string;
  artist?: { id?: string; name?: string };
}

interface Recording {
  id?: string;
  title?: string;
  genres?: NamedThing[];
  'artist-credit'?: ArtistCredit[];
  releases?: { 'release-group'?: { id?: string; title?: string } }[];
}

export function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\bn\b/g, 'and')
    .replace(/\s+/g, ' ');
}

/**
 * Strips the things an upload title carries and a catalogue does not. Without
 * this, `Song (2011 Remaster)` never equals `Song` and a real match is thrown
 * away as a mismatch.
 */
export function songTitle(value: string): string {
  const qualifiers = [
    /\s*[[(](?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?[\])]/giu,
    /\s*[[(](?:official(?:\s+music)?\s+video|official\s+audio|official\s+visuali[sz]er|lyric\s+video|visuali[sz]er|hd\s+upscale)[\])]/giu,
    /\s*[[(](?:feat(?:uring)?\.?|ft\.?)\s+[^\])]+[\])]/giu,
    /\s*[[(]no\s+[^\])]+\s+version[\])]/giu,
    /\s*[[(]from\s+[^\])]*soundtrack[\])]/giu,
    /\s*[[(]\d{4}[\])]/gu,
  ];
  return qualifiers.reduce((title, pattern) => title.replace(pattern, ''), value).trim();
}

function tokens(value: string | null | undefined): Set<string> {
  const ignored = new Set(['and', 'the', 'feat', 'featuring', 'ft', 'with', 'x']);
  return new Set(normalize(value).split(' ').filter((token) => token && !ignored.has(token)));
}

function tokenSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function creditedArtist(recording: Recording): string | null {
  const credit = recording['artist-credit']
    ?.map((part) => `${part.name ?? part.artist?.name ?? ''}${part.joinphrase ?? ''}`)
    .join('')
    .trim();
  return credit || null;
}

/**
 * Whether the artist MusicBrainz credits is the one the upload named. A
 * collaboration is credited as one string, so an exact match on either the
 * whole credit or any one name counts, and a near miss is allowed on tokens.
 */
function artistMatches(expected: string, recording: Recording): boolean {
  const credit = creditedArtist(recording);
  if (normalize(expected) === normalize(credit)) return true;
  const names = recording['artist-credit']
    ?.flatMap((part) => (part.name ?? part.artist?.name ? [part.name ?? part.artist!.name!] : []))
    ?? [];
  if (names.some((name) => normalize(name) === normalize(expected))) return true;
  return tokenSimilarity(expected, credit) >= 0.8;
}

function lucenePhrase(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

export interface RecordingMatch {
  mbid: string;
  title: string;
  artist: string | null;
}

/**
 * Finds the recording a track is, or nothing.
 *
 * It checks catalogue facts -- the song title and a compatible artist credit --
 * rather than trying to establish that this is the same performance. A cover,
 * a live take and the studio version are different recordings that this cannot
 * tell apart, which is the right trade for a genre: they share one.
 */
export async function findRecording(
  title: string,
  artist: string,
): Promise<RecordingMatch | null> {
  const endpoint = new URL(`${ENDPOINT}/recording`);
  endpoint.searchParams.set(
    'query',
    `recording:${lucenePhrase(songTitle(title))} AND artist:${lucenePhrase(artist)}`,
  );
  endpoint.searchParams.set('limit', String(SEARCH_LIMIT));
  endpoint.searchParams.set('fmt', 'json');

  const answer = await request<{ recordings?: Recording[] }>(endpoint);
  const wanted = normalize(songTitle(title));
  for (const recording of answer.recordings ?? []) {
    if (!recording.id) continue;
    if (normalize(songTitle(recording.title ?? '')) !== wanted) continue;
    if (!artistMatches(artist, recording)) continue;
    return {
      mbid: recording.id,
      title: recording.title ?? title,
      artist: creditedArtist(recording),
    };
  }
  return null;
}

export interface MusicBrainzGenre {
  level: GenreLevel;
  genres: string[];
  /** The entity the genre is on, which is also what the link points at. */
  entityId: string;
  url: string;
}

function names(genres: NamedThing[] | undefined): string[] {
  return genres?.flatMap((genre) => (genre.name ? [genre.name] : [])) ?? [];
}

function lookup(entity: string, mbid: string, inc: string): URL {
  const endpoint = new URL(`${ENDPOINT}/${entity}/${mbid}`);
  endpoint.searchParams.set('inc', inc);
  endpoint.searchParams.set('fmt', 'json');
  return endpoint;
}

/**
 * The best genre MusicBrainz has for a recording, and how close to the track it
 * actually is. The recording is asked first, then the release group it appeared
 * on, then the artist -- and the artist answer is returned labelled as such
 * rather than dressed up as a description of the track.
 *
 * Only the first release group and the first artist are looked up. Asking about
 * all of them multiplies requests against a one-a-second limit for a coverage
 * gain measured in single tracks.
 */
export async function findGenres(mbid: string): Promise<MusicBrainzGenre | null> {
  const recording = await request<Recording>(
    lookup('recording', mbid, 'genres+artist-credits+releases+release-groups'),
  );

  const fromRecording = names(recording.genres);
  if (fromRecording.length > 0) {
    return {
      level: 'recording',
      genres: fromRecording,
      entityId: mbid,
      url: `https://musicbrainz.org/recording/${mbid}`,
    };
  }

  const releaseGroupId = recording.releases?.flatMap(
    (release) => (release['release-group']?.id ? [release['release-group'].id] : []),
  )[0];
  if (releaseGroupId) {
    const releaseGroup = await request<{ genres?: NamedThing[] }>(
      lookup('release-group', releaseGroupId, 'genres'),
    );
    const fromReleaseGroup = names(releaseGroup.genres);
    if (fromReleaseGroup.length > 0) {
      return {
        level: 'release_group',
        genres: fromReleaseGroup,
        entityId: releaseGroupId,
        url: `https://musicbrainz.org/release-group/${releaseGroupId}`,
      };
    }
  }

  const artistId = recording['artist-credit']?.flatMap(
    (credit) => (credit.artist?.id ? [credit.artist.id] : []),
  )[0];
  if (artistId) {
    const artist = await request<{ genres?: NamedThing[] }>(lookup('artist', artistId, 'genres'));
    const fromArtist = names(artist.genres);
    if (fromArtist.length > 0) {
      return {
        level: 'artist',
        genres: fromArtist,
        entityId: artistId,
        url: `https://musicbrainz.org/artist/${artistId}`,
      };
    }
  }

  return null;
}
