import { eq, inArray } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import { mediaLookups } from './db/schema';
import { getEnv } from './env';
import {
  inspectMedia,
  inspectYouTubeVideos,
  MediaLookupError,
  parseMediaUrl,
  regionPlaybackIssue,
  type MediaInspection,
  type MediaMetadata,
  type ParsedMediaUrl,
  type RegionRestriction,
} from './media';

/**
 * How long a stored answer stands. Nothing here depends on the playback region:
 * a row keeps the countries YouTube named rather than a verdict about one of
 * them, so moving the room's region re-reads the same row instead of asking
 * every provider again.
 *
 * 1. A row recording a playback issue stands for an hour, whichever provider
 *    gave it. A video being non-embeddable or age restricted, or a track not
 *    streaming, is the kind of answer most likely to change on its own, and an
 *    hour is long enough that a burst of attempts in one sitting costs one
 *    lookup rather than one per attempt.
 * 2. Any other row stands for a day. A track can be pulled, made private, or
 *    restricted after it was accepted, and neither provider says when.
 */
const PLAYABLE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PLAYBACK_ISSUE_MAX_AGE_MS = 60 * 60 * 1_000;

function cacheKey(parsed: ParsedMediaUrl): string {
  if (parsed.provider === 'youtube') return `youtube:${parsed.providerMediaId}`;
  // A SoundCloud track has no id until it resolves, so the permalink path is
  // the only key available before the lookup runs.
  const path = parsed.url.pathname.replace(/\/+$/, '').toLowerCase();
  return `soundcloud:${parsed.url.hostname.toLowerCase()}${path}`;
}

interface CachedAnswer {
  metadata: MediaMetadata;
  playbackIssueCode: string | null;
  playbackIssueMessage: string | null;
  regionRestriction: RegionRestriction;
  checkedAt: Date;
}

/** Only the age and whether it recorded a refusal decide this. */
function isFresh(cached: Pick<CachedAnswer, 'playbackIssueCode' | 'checkedAt'>): boolean {
  const age = Date.now() - cached.checkedAt.getTime();
  return age < (cached.playbackIssueCode ? PLAYBACK_ISSUE_MAX_AGE_MS : PLAYABLE_MAX_AGE_MS);
}

function storedIssue(cached: CachedAnswer): MediaLookupError | null {
  if (!cached.playbackIssueCode) return null;
  return new MediaLookupError(
    cached.playbackIssueCode,
    cached.playbackIssueMessage ?? 'The room cannot play that track.',
  );
}

/**
 * Returns the stored answer when it is still good, otherwise asks the provider
 * and writes the new answer over the old one. A failed re-check throws and
 * leaves the stored row untouched, so the next attempt checks again rather than
 * serving something known to be stale.
 */
/**
 * Resolves several links at once so a playlist import does not make one round
 * trip after another. Failures are kept: the caller reports which tracks it
 * could not take and why.
 */
export async function lookupManyCached(
  urls: string[],
  targetCountry: string,
  db: Database = getDatabase(),
): Promise<Map<string, MediaMetadata | Error>> {
  return resolveMany(urls, (url) => lookupMediaCached(url, targetCountry, db));
}

/** The same batching for the personal library, which keeps unplayable tracks. */
export async function inspectManyCached(
  urls: string[],
  targetCountry: string,
  db: Database = getDatabase(),
): Promise<Map<string, MediaInspection | Error>> {
  return resolveMany(urls, (url) => inspectMediaCached(url, targetCountry, db));
}

async function resolveMany<T>(
  urls: string[],
  resolve: (url: string) => Promise<T>,
): Promise<Map<string, T | Error>> {
  const results = new Map<string, T | Error>();
  const concurrency = 5;

  for (let start = 0; start < urls.length; start += concurrency) {
    const batch = urls.slice(start, start + concurrency);
    await Promise.all(
      batch.map(async (url) => {
        try {
          results.set(url, await resolve(url));
        } catch (error) {
          results.set(url, error instanceof Error ? error : new Error('Lookup failed.'));
        }
      }),
    );
  }
  return results;
}

export async function lookupMediaCached(
  url: string,
  targetCountry: string,
  db: Database = getDatabase(),
): Promise<MediaMetadata> {
  const inspected = await inspectMediaCached(url, targetCountry, db);
  if (inspected.playbackIssue) throw inspected.playbackIssue;
  return inspected.metadata;
}

export async function inspectMediaCached(
  url: string,
  targetCountry: string,
  db: Database = getDatabase(),
): Promise<MediaInspection> {
  const parsed = parseMediaUrl(url);
  const key = cacheKey(parsed);

  const [cached] = await db
    .select({
      metadata: mediaLookups.metadata,
      playbackIssueCode: mediaLookups.playbackIssueCode,
      playbackIssueMessage: mediaLookups.playbackIssueMessage,
      regionRestriction: mediaLookups.regionRestriction,
      checkedAt: mediaLookups.checkedAt,
    })
    .from(mediaLookups)
    .where(eq(mediaLookups.key, key))
    .limit(1);

  if (cached && isFresh(cached)) {
    return forRegion(
      {
        metadata: cached.metadata,
        playbackIssue: storedIssue(cached),
        regionRestriction: cached.regionRestriction,
      },
      targetCountry,
    );
  }

  const env = getEnv();
  const inspected = await inspectMedia(url, { youtubeApiKey: env.YOUTUBE_API_KEY });
  await store(key, inspected, db);
  return forRegion(inspected, targetCountry);
}

/** Writes one provider answer over whatever was stored for that track before. */
async function store(key: string, inspected: MediaInspection, db: Database): Promise<void> {
  const { metadata, playbackIssue, regionRestriction } = inspected;
  const row = {
    provider: metadata.provider,
    metadata,
    playbackIssueCode: playbackIssue?.code ?? null,
    playbackIssueMessage: playbackIssue?.message ?? null,
    regionRestriction,
    checkedAt: new Date(),
  };
  await db
    .insert(mediaLookups)
    .values({ key, ...row })
    .onConflictDoUpdate({ target: mediaLookups.key, set: row });
}

/**
 * Asks YouTube about many videos at once and stores what it says, so the
 * per-track path that follows is answered from here.
 *
 * It exists for quota. `videos.list` costs one unit however many ids it is
 * given, up to fifty, so an import that warms the cache this way spends one
 * unit per fifty tracks instead of one per track. Everything else about the
 * answers is unchanged, including refusals, which are stored exactly as a
 * single lookup would store them.
 *
 * Failures are not thrown: a video this could not read is simply not cached,
 * and the caller's own lookup asks about it again and reports it properly.
 */
export async function warmYouTubeLookups(
  urls: string[],
  db: Database = getDatabase(),
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const url of urls) {
    try {
      const parsed = parseMediaUrl(url);
      if (parsed.provider !== 'youtube' || !parsed.providerMediaId) continue;
      wanted.set(parsed.providerMediaId, cacheKey(parsed));
    } catch {
      // Not a link this room can read. The caller's own lookup says so.
    }
  }
  if (wanted.size === 0) return;

  const cached = await db
    .select({
      key: mediaLookups.key,
      playbackIssueCode: mediaLookups.playbackIssueCode,
      checkedAt: mediaLookups.checkedAt,
    })
    .from(mediaLookups)
    .where(inArray(mediaLookups.key, [...wanted.values()]));
  const fresh = new Set(cached.filter(isFresh).map((row) => row.key));

  const ids = [...wanted].filter(([, key]) => !fresh.has(key)).map(([id]) => id);
  if (ids.length === 0) return;

  const env = getEnv();
  const answers = await inspectYouTubeVideos(ids, { youtubeApiKey: env.YOUTUBE_API_KEY });
  for (const [id, answer] of answers) {
    const key = wanted.get(id);
    if (!key || answer instanceof Error) continue;
    await store(key, answer, db);
  }
}

/** Settles the one question the stored answer deliberately left open. */
function forRegion(inspected: MediaInspection, targetCountry: string): MediaInspection {
  if (inspected.playbackIssue) return inspected;
  return {
    ...inspected,
    playbackIssue: regionPlaybackIssue(inspected.regionRestriction, targetCountry),
  };
}
