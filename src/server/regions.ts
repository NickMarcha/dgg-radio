import { asc } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase, type Database } from './db/client';
import { playbackRegions } from './db/schema';
import { getEnv } from './env';
import type { PlaybackRegion } from '../shared/contracts';

/**
 * YouTube's region list only changes when a country is added, so one call a
 * month is plenty. It is cached in the database rather than in memory so a
 * server restart does not spend another request.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const regionsResponseSchema = z.object({
  items: z.array(
    z.object({
      snippet: z.object({
        gl: z.string(),
        name: z.string(),
      }),
    }),
  ),
});

export class RegionLookupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'RegionLookupError';
  }
}

async function fetchRegions(fetcher: typeof fetch): Promise<PlaybackRegion[]> {
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/i18nRegions');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('key', getEnv().YOUTUBE_API_KEY);

  const response = await fetcher(endpoint, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new RegionLookupError('REGIONS_LOOKUP_FAILED', 'YouTube did not return its region list.');
  }

  const result = regionsResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new RegionLookupError('REGIONS_LOOKUP_FAILED', 'YouTube returned an unexpected region list.');
  }

  return result.data.items
    .map(({ snippet }) => ({ code: snippet.gl.toUpperCase(), name: snippet.name }))
    .filter(({ code }) => /^[A-Z]{2}$/.test(code));
}

/**
 * Serves the stored list while it is still young, otherwise asks YouTube and
 * replaces it. A refused request throws and leaves the stored rows alone, so a
 * quota blip keeps serving the old list instead of emptying the field.
 */
export async function listPlaybackRegions(
  fetcher: typeof fetch = fetch,
  db: Database = getDatabase(),
): Promise<PlaybackRegion[]> {
  const stored = await db
    .select({
      code: playbackRegions.code,
      name: playbackRegions.name,
      fetchedAt: playbackRegions.fetchedAt,
    })
    .from(playbackRegions)
    .orderBy(asc(playbackRegions.name));

  const fetchedAt = stored[0]?.fetchedAt;
  if (fetchedAt && fetchedAt.getTime() > Date.now() - MAX_AGE_MS) {
    return stored.map(({ code, name }) => ({ code, name }));
  }

  const regions = await fetchRegions(fetcher);

  // Replacing the list wholesale drops countries YouTube has withdrawn, which
  // an upsert would leave behind for good.
  await db.transaction(async (transaction) => {
    await transaction.delete(playbackRegions);
    if (regions.length > 0) {
      await transaction.insert(playbackRegions).values(
        regions.map((region) => ({ ...region, fetchedAt: new Date() })),
      );
    }
  });

  return [...regions].sort((left, right) => left.name.localeCompare(right.name));
}
