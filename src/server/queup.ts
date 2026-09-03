import { desc, inArray } from 'drizzle-orm';
import { getDatabase, type Database } from './db/client';
import { legacyPlays } from './db/schema';

/**
 * Topping the archive up from the room QueUp still runs.
 *
 * The bulk import is a script and a committed file, because two years of
 * history is 2,400 pages and belongs nowhere near a request. What this does is
 * the small end of the same job: read the newest pages, stop as soon as a whole
 * page is already known, and insert whatever is new. A month of silence is a
 * few pages; an afternoon of listening is one.
 *
 * Rows are keyed by QueUp's own id for the play, so running it twice in a row
 * adds nothing the second time and nothing can be duplicated.
 */

const API = 'https://api.queup.net';
/** Twenty plays a page, so this reaches about three days of a busy room. */
const MAX_PAGES = 40;

export class QueupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'QueupError';
  }
}

interface QueupPlay {
  _id: string;
  played?: number;
  skipped?: boolean;
  updubs?: number;
  downdubs?: number;
  _user?: { username?: string } | null;
  _song?: {
    fkid?: string;
    type?: string;
    name?: string;
    songLength?: number;
    images?: { thumbnail?: string | null } | null;
  } | null;
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 302) {
    throw new QueupError('QUEUP_PRIVATE', 'That QueUp room is not public.', 400);
  }
  if (!response.ok) {
    throw new QueupError('QUEUP_UNAVAILABLE', `QueUp answered ${response.status}.`);
  }
  const body = (await response.json()) as { code?: number; data?: unknown };
  if (body.code !== 200) {
    throw new QueupError('QUEUP_UNAVAILABLE', `QueUp answered code ${body.code}.`);
  }
  return body.data;
}

type NewPlay = typeof legacyPlays.$inferInsert;

/**
 * What QueUp knew, as a row this room can store. A play whose track has since
 * been deleted from their catalogue names nothing importable, so it is dropped
 * rather than carried as a hole.
 */
function toRow(entry: QueupPlay): NewPlay | null {
  const song = entry._song;
  if (!song?.fkid || !song.type || !entry.played) return null;
  if (song.type !== 'youtube' && song.type !== 'soundcloud') return null;
  const durationSeconds = Math.round((song.songLength ?? 0) / 1000);
  if (durationSeconds <= 0) return null;

  return {
    sourceId: entry._id,
    playedAt: new Date(entry.played),
    requesterName: entry._user?.username ?? 'unknown',
    provider: song.type,
    providerMediaId: song.fkid,
    title: song.name ?? song.fkid,
    durationSeconds,
    thumbnailUrl: song.images?.thumbnail ?? null,
    upvotes: entry.updubs ?? 0,
    downvotes: entry.downdubs ?? 0,
    skipped: Boolean(entry.skipped),
  };
}

export interface ArchiveRefresh {
  /** Plays that were not already in the archive. */
  added: number;
  /** Pages read before it stopped. */
  pagesRead: number;
  /** True when it stopped at the page cap rather than at known ground. */
  reachedLimit: boolean;
  /** When the newest play in the archive happened, after the refresh. */
  newestPlayedAt: string | null;
}

/**
 * Reads the newest pages of a QueUp room's history and stores what is new.
 *
 * It stops at the first page that is entirely known, which is the point where
 * the archive and the live room have met. That check is per page rather than
 * per play because the API pages by offset into a list that grows at the front:
 * a track playing while this runs shifts everything back by one, so a single
 * familiar id in a page proves nothing.
 */
export async function refreshArchive(
  slug: string,
  db: Database = getDatabase(),
): Promise<ArchiveRefresh> {
  const room = (await get(`/room/${slug}`)) as { _id?: string } | null;
  if (!room?._id) {
    throw new QueupError('QUEUP_ROOM_NOT_FOUND', `QueUp has no room called "${slug}".`, 404);
  }

  let added = 0;
  let pagesRead = 0;
  let reachedLimit = true;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await get(`/room/${room._id}/playlist/history?page=${page}`);
    const entries = Array.isArray(data) ? (data as QueupPlay[]) : [];
    pagesRead = page;
    if (entries.length === 0) {
      reachedLimit = false;
      break;
    }

    const rows = entries.flatMap((entry) => toRow(entry) ?? []);
    if (rows.length === 0) continue;

    const known = await db
      .select({ sourceId: legacyPlays.sourceId })
      .from(legacyPlays)
      .where(inArray(legacyPlays.sourceId, rows.map((row) => row.sourceId)));
    if (known.length === rows.length) {
      // The whole page is already here, so everything older is too.
      reachedLimit = false;
      break;
    }

    const written = await db
      .insert(legacyPlays)
      .values(rows)
      .onConflictDoNothing()
      .returning({ sourceId: legacyPlays.sourceId });
    added += written.length;
  }

  // How current the archive is now, which is the useful thing to report back.
  const [newest] = await db
    .select({ playedAt: legacyPlays.playedAt })
    .from(legacyPlays)
    .orderBy(desc(legacyPlays.playedAt))
    .limit(1);

  return {
    added,
    pagesRead,
    reachedLimit,
    newestPlayedAt: newest?.playedAt.toISOString() ?? null,
  };
}
