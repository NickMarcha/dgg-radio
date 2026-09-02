import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type {
  HistoryQuery,
  LegacyHistoryPage,
  LegacyPlay,
  LegacyStats,
  MediaProvider,
  StatsPeriod,
} from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { legacyPlays, media } from './db/schema';
import { listGenres, matchesGenre, trackKey } from './genre';
import { MediaLookupError, soundCloudPermalink } from './media';
import { enqueueMedia } from './room';
import { ALL_TIME, withinPeriod } from './period';
import { likePattern } from './search';

/**
 * Reading the room's QueUp history, which is an archive rather than part of the
 * room. `scripts/queup-import-room.ts` is the only thing that writes it, and
 * nothing in the live room reads it: the stats, profiles, rotation and repeat
 * cooldown all stay about what has happened here.
 */

/**
 * A link to the track's own page, where the provider's id is enough to build
 * one. QueUp stored SoundCloud tracks by numeric id, which names nothing
 * without asking SoundCloud, so those have no link until someone resolves them.
 */
function canonicalUrl(provider: LegacyPlay['provider'], providerMediaId: string): string | null {
  return provider === 'youtube' ? `https://www.youtube.com/watch?v=${providerMediaId}` : null;
}

/**
 * The link the room can act on, for anything QueUp recorded. QueUp stored
 * YouTube tracks by video id, which makes a URL on its own, and SoundCloud
 * tracks by numeric id, which does not: SoundCloud has to name the permalink
 * first. Both the archive and the personal playlist import go through here.
 */
export async function queupTrackUrl(
  provider: string,
  providerMediaId: string,
): Promise<string> {
  if (provider === 'youtube') return `https://www.youtube.com/watch?v=${providerMediaId}`;
  if (provider === 'soundcloud') return soundCloudPermalink(providerMediaId);
  throw new MediaLookupError('UNSUPPORTED_PROVIDER', `This room cannot play ${provider} tracks.`);
}

/** One archived play, or nothing when the id names none. */
async function findLegacyPlay(
  sourceId: string,
  db: Database,
): Promise<{ provider: MediaProvider; providerMediaId: string } | null> {
  const [play] = await db
    .select({
      provider: legacyPlays.provider,
      providerMediaId: legacyPlays.providerMediaId,
    })
    .from(legacyPlays)
    .where(eq(legacyPlays.sourceId, sourceId))
    .limit(1);
  return play ?? null;
}

/**
 * Requests a track out of the archive. Everything the room normally decides
 * about a request still decides it -- the rules, the repeat cooldown, the DJ
 * rotation, the length limit -- because this only turns an archived play into
 * a link and then asks the room for it in the ordinary way.
 */
export async function enqueueLegacyPlay(
  sourceId: string,
  user: AuthenticatedUser,
  db: Database = getDatabase(),
): ReturnType<typeof enqueueMedia> {
  const play = await findLegacyPlay(sourceId, db);
  if (!play) {
    throw new MediaLookupError('LEGACY_PLAY_NOT_FOUND', 'That archived track is not there.');
  }
  return enqueueMedia(await queupTrackUrl(play.provider, play.providerMediaId), user, db);
}

/**
 * What the archive says about tracks and about who requested them.
 *
 * It cannot go through the room's own stats: there is no `media` row and no
 * account behind any of this, and QueUp stored votes as a total on each play
 * rather than as one row per person. So the numbers are summed from the plays,
 * and everything is keyed by what QueUp knew — a provider id and a name.
 */
export async function getLegacyStats(
  limit = 100,
  period: StatsPeriod = ALL_TIME,
  db: Database = getDatabase(),
): Promise<LegacyStats> {
  const within = withinPeriod(legacyPlays.playedAt, period);
  const [tracks, jammers, [totals]] = await Promise.all([
    db
      .select({
        provider: legacyPlays.provider,
        providerMediaId: legacyPlays.providerMediaId,
        title: sql<string>`min(${legacyPlays.title})`,
        thumbnailUrl: sql<string | null>`min(${legacyPlays.thumbnailUrl})`,
        plays: sql<number>`count(*)::int`.mapWith(Number),
        upvotes: sql<number>`sum(${legacyPlays.upvotes})::int`.mapWith(Number),
        downvotes: sql<number>`sum(${legacyPlays.downvotes})::int`.mapWith(Number),
      })
      .from(legacyPlays)
      .where(within)
      .groupBy(legacyPlays.provider, legacyPlays.providerMediaId)
      .orderBy(desc(sql`count(*)`), desc(sql`sum(${legacyPlays.upvotes} - ${legacyPlays.downvotes})`))
      .limit(limit),
    db
      .select({
        requesterName: legacyPlays.requesterName,
        plays: sql<number>`count(*)::int`.mapWith(Number),
        upvotes: sql<number>`sum(${legacyPlays.upvotes})::int`.mapWith(Number),
        downvotes: sql<number>`sum(${legacyPlays.downvotes})::int`.mapWith(Number),
      })
      .from(legacyPlays)
      .where(within)
      .groupBy(legacyPlays.requesterName)
      .orderBy(desc(sql`sum(${legacyPlays.upvotes} - ${legacyPlays.downvotes})`), desc(sql`count(*)`))
      .limit(limit),
    db
      .select({
        plays: sql<number>`count(*)::int`.mapWith(Number),
        tracks: sql<number>`count(distinct ${legacyPlays.providerMediaId})::int`.mapWith(Number),
        people: sql<number>`count(distinct ${legacyPlays.requesterName})::int`.mapWith(Number),
        since: sql<Date | null>`min(${legacyPlays.playedAt})`,
      })
      .from(legacyPlays)
      .where(within),
  ]);

  return {
    tracks: tracks.map((row) => ({
      provider: row.provider,
      providerMediaId: row.providerMediaId,
      title: row.title,
      canonicalUrl: canonicalUrl(row.provider, row.providerMediaId),
      thumbnailUrl: row.thumbnailUrl,
      plays: row.plays,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      score: row.upvotes - row.downvotes,
    })),
    jammers: jammers.map((row) => ({
      requesterName: row.requesterName,
      plays: row.plays,
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      score: row.upvotes - row.downvotes,
    })),
    totals: {
      plays: totals?.plays ?? 0,
      tracks: totals?.tracks ?? 0,
      people: totals?.people ?? 0,
      since: totals?.since ? new Date(totals.since).toISOString() : null,
    },
  };
}

/**
 * One page of the archive, newest first, by offset so that the page somebody is
 * reading can be put in a link. Nothing is ever added to this table except by a
 * re-import, so an offset here is as stable as a cursor would be. Its own id
 * breaks ties on the play time.
 */
export async function listLegacyHistory(
  query: HistoryQuery = {},
  db: Database = getDatabase(),
): Promise<LegacyHistoryPage> {
  const { limit = 50, page = 1, search = null, genre = null } = query;
  // The archive has no artist column -- QueUp never stored one -- so the title
  // and whoever requested it are everything there is to search.
  const matching = and(
    search
      ? or(
          ilike(legacyPlays.title, likePattern(search)),
          ilike(legacyPlays.requesterName, likePattern(search)),
        )
      : undefined,
    genre
      ? matchesGenre(legacyPlays.provider, legacyPlays.providerMediaId, genre)
      : undefined,
  );
  const [rows, [counted]] = await Promise.all([
    db
      .select({ play: legacyPlays, mediaId: media.id })
      .from(legacyPlays)
      // The archive stores a provider and an id, not a media row. Most of those
      // ids name nothing here, but a track the room has since played has a row
      // already, and this finds it for the price of an indexed join rather than
      // a provider lookup. It is what lets an archived track be saved to a
      // playlist and show whether it is in one.
      .leftJoin(
        media,
        and(
          eq(media.provider, legacyPlays.provider),
          eq(media.providerMediaId, legacyPlays.providerMediaId),
        ),
      )
      .where(matching)
      .orderBy(desc(legacyPlays.playedAt), desc(legacyPlays.sourceId))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
      .from(legacyPlays)
      .where(matching),
  ]);

  const genres = await listGenres(
    rows.map(({ play }) => ({
      provider: play.provider,
      providerMediaId: play.providerMediaId,
    })),
    db,
  );

  const entries: LegacyPlay[] = rows.map(({ play, mediaId }) => ({
    id: play.sourceId,
    provider: play.provider,
    providerMediaId: play.providerMediaId,
    title: play.title,
    canonicalUrl: canonicalUrl(play.provider, play.providerMediaId),
    durationSeconds: play.durationSeconds,
    thumbnailUrl: play.thumbnailUrl,
    mediaId,
    genres: genres.get(trackKey(play.provider, play.providerMediaId)) ?? null,
    requesterName: play.requesterName,
    playedAt: play.playedAt.toISOString(),
    upvotes: play.upvotes,
    downvotes: play.downvotes,
    skipped: play.skipped,
  }));

  return { entries, total: counted?.total ?? 0 };
}
