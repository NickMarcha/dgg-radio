/**
 * The "Music" card YouTube shows under a video, which names the track and the
 * artist as a catalogue would rather than as an uploader typed them.
 *
 * This is what makes identity resolution work at all. `Fatboy Slim - Right
 * Here, Right Now [Official 4K Video]` is not a title any catalogue holds, and
 * `Fatboy Slim` is not who the upload is credited to -- the channel is. The
 * card carries both properly, on 78% of the room's tracks.
 *
 * There is no API for it. The card comes out of the watch page's own
 * `ytInitialData`, which is YouTube's private response and will change shape
 * without warning. So this is deliberately confined to the offline enrichment
 * script: nothing a listener does depends on it, and when it breaks the room
 * carries on with whatever genres it already has.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * One watch page at a time, two seconds apart, for the whole process.
 *
 * Enrichment starts up to two hundred lookups at once, and MusicBrainz and
 * Discogs each serialize their own share behind a limiter of their own. This
 * had none, so a few playlist imports arriving together meant two hundred
 * concurrent requests to YouTube — and eight concurrent is what earned a
 * `google.com/sorry` block on the address that ran the backfill. A single
 * caller at this spacing read 25,220 pages without one refusal.
 *
 * It belongs here rather than in each caller because the address is what gets
 * blocked, and the address is shared by everything in the process.
 */
const REQUEST_SPACING_MS = 2_000;

let nextSlot = Promise.resolve();

function waitForSlot(): Promise<void> {
  const waited = nextSlot;
  nextSlot = waited.then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return waited;
}

/**
 * A page that would not answer, with what it said about coming back.
 *
 * YouTube sends no rate-limit headers on a good response, so there is nothing
 * to pace against in advance — the only signal is the refusal itself. Keeping
 * `Retry-After` off it means a caller has to guess how long to wait, and a
 * guess that is too short is what earns the next refusal.
 */
export class WatchPageError extends Error {
  readonly status: number;
  /** What the response asked for, in milliseconds, or null if it said nothing. */
  readonly retryAfterMs: number | null;

  constructor(response: Response) {
    super(`The watch page answered ${response.status}`);
    this.name = 'WatchPageError';
    this.status = response.status;
    const header = Number(response.headers.get('retry-after'));
    this.retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1_000 : null;
  }
}

export interface MusicCard {
  title: string;
  artist: string;
  album: string | null;
}

/**
 * Reads the object literal assigned after a marker, by counting braces. The
 * page is not JSON and there is no terminator to search for, so the end of the
 * object has to be found rather than matched.
 */
function assignedObject(html: string, marker: string): unknown {
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) throw new Error(`${marker.trim()} was absent`);
  const start = html.indexOf('{', markerAt + marker.length);
  if (start < 0) throw new Error(`${marker.trim()} had no object`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error(`${marker.trim()} was not terminated`);
}

function initialData(html: string): unknown {
  if (html.includes('var ytInitialData = ')) return assignedObject(html, 'var ytInitialData = ');

  const scriptAt = html.indexOf('<script id="yt-initial-data"');
  if (scriptAt < 0) throw new Error('YouTube initial data was absent');
  const start = html.indexOf('>', scriptAt) + 1;
  const end = html.indexOf('</script>', start);
  if (start === 0 || end < 0) throw new Error('YouTube initial data script was malformed');
  return JSON.parse(html.slice(start, end));
}

/** Every object under `key`, wherever it sits. The page nests these deeply. */
function objectsNamed(value: unknown, key: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [name, child] of Object.entries(candidate)) {
      if (name === key && child && typeof child === 'object' && !Array.isArray(child)) {
        found.push(child as Record<string, unknown>);
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}

function at(value: unknown, path: (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstCard(data: unknown): MusicCard | null {
  const lists = objectsNamed(data, 'horizontalCardListRenderer').filter(
    (list) => at(list, ['header', 'richListHeaderRenderer', 'title', 'simpleText']) === 'Music',
  );
  for (const list of lists) {
    if (!Array.isArray(list.cards)) continue;
    for (const card of list.cards) {
      const view = at(card, ['videoAttributeViewModel']);
      if (!view || typeof view !== 'object' || Array.isArray(view)) continue;
      const record = view as Record<string, unknown>;
      const title = text(record.title);
      const artist = text(record.subtitle);
      // Both or neither: a card with no artist cannot be searched for.
      if (!title || !artist) continue;
      return { title, artist, album: text(at(record, ['secondarySubtitle', 'content'])) };
    }
  }
  return null;
}

/**
 * The Music card for a video, or null when the video has none -- which is the
 * normal answer for about a fifth of them, and for anything that is not music.
 * A page that cannot be read at all throws, so a run can tell a video with no
 * card apart from YouTube having changed its response.
 */
export async function findMusicCard(videoId: string): Promise<MusicCard | null> {
  await waitForSlot();
  const endpoint = new URL('https://www.youtube.com/watch');
  endpoint.searchParams.set('v', videoId);
  endpoint.searchParams.set('hl', 'en');
  endpoint.searchParams.set('gl', 'US');

  const response = await fetch(endpoint, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': ACCEPT_LANGUAGE },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new WatchPageError(response);
  return firstCard(initialData(await response.text()));
}
