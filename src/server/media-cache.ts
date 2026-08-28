import { eq } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import { mediaLookups } from './db/schema';
import { getEnv } from './env';
import { lookupMedia, parseMediaUrl, type MediaMetadata, type ParsedMediaUrl } from './media';

/**
 * YouTube answers expire because a video can become region blocked, age
 * restricted, or non-embeddable after it was accepted. SoundCloud answers do
 * not: the actor run costs money and reports nothing that changes on its own.
 */
const YOUTUBE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function cacheKey(parsed: ParsedMediaUrl): string {
  if (parsed.provider === 'youtube') return `youtube:${parsed.providerMediaId}`;
  // A SoundCloud track has no id until it resolves, so the permalink path is
  // the only key available before the lookup runs.
  const path = parsed.url.pathname.replace(/\/+$/, '').toLowerCase();
  return `soundcloud:${parsed.url.hostname.toLowerCase()}${path}`;
}

function isFresh(provider: MediaMetadata['provider'], checkedAt: Date): boolean {
  if (provider !== 'youtube') return true;
  return checkedAt.getTime() > Date.now() - YOUTUBE_MAX_AGE_MS;
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
  const results = new Map<string, MediaMetadata | Error>();
  const concurrency = 5;

  for (let start = 0; start < urls.length; start += concurrency) {
    const batch = urls.slice(start, start + concurrency);
    await Promise.all(
      batch.map(async (url) => {
        try {
          results.set(url, await lookupMediaCached(url, targetCountry, db));
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
  const parsed = parseMediaUrl(url);
  const key = cacheKey(parsed);

  const [cached] = await db
    .select({ metadata: mediaLookups.metadata, checkedAt: mediaLookups.checkedAt })
    .from(mediaLookups)
    .where(eq(mediaLookups.key, key))
    .limit(1);

  if (cached && isFresh(cached.metadata.provider, cached.checkedAt)) {
    return cached.metadata;
  }

  const env = getEnv();
  const metadata = await lookupMedia(
    url,
    { youtubeApiKey: env.YOUTUBE_API_KEY },
    targetCountry,
  );

  const checkedAt = new Date();
  await db
    .insert(mediaLookups)
    .values({ key, provider: metadata.provider, metadata, checkedAt })
    .onConflictDoUpdate({
      target: mediaLookups.key,
      set: { provider: metadata.provider, metadata, checkedAt },
    });

  return metadata;
}
