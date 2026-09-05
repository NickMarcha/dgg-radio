/**
 * Exports one QueUp room — everything the room's own pages read — into a single
 * JSON file for importing into DGG Radio.
 *
 * QueUp's official data export is gone, but the API its web client calls is
 * public and unauthenticated for room data: the played history, the people who
 * played, the staff list, the ban list, and the moderation audit log all answer
 * without a session. So this needs no cookie, no token, and anybody can run it
 * against any public room:
 *
 *   npx tsx scripts/queup-export-room.ts dgg-radio
 *   npx tsx scripts/queup-export-room.ts dgg-radio --out room.json --pages 20
 *
 * The room argument is the slug from the room's URL (`queup.net/join/dgg-radio`)
 * or its raw id. `--pages` stops early, which is how to take a small sample
 * without walking the whole history.
 *
 * Personal playlists are the other half of a move and are NOT here: those need
 * the owner's own session, so they come out of `public/queup-export-playlists.js`
 * pasted into the browser console instead.
 */

import { writeFile } from 'node:fs/promises';

const API = 'https://api.queup.net';

/** What one page of history holds, which is also how the API reports "no more". */
const PAGE_SIZE = 20;

/**
 * How many history pages are in flight at once. The room's own client fetches
 * playlist pages five at a time, so five is a rate this API is used to.
 */
const CONCURRENCY = 5;

interface QueupSong {
  _id: string;
  name: string;
  type: string;
  /** The provider's own id: a YouTube video id, or a numeric SoundCloud track id. */
  fkid: string;
  songLength: number;
  images?: { thumbnail?: string | null } | null;
}

interface QueupUser {
  _id: string;
  username: string;
}

interface QueupPlay {
  _id: string;
  created: number;
  played: number | null;
  skipped: boolean;
  updubs: number;
  downdubs: number;
  songid: string;
  userid: string;
  _song?: QueupSong | null;
  _user?: QueupUser | null;
}

export interface ExportedPlay {
  /** QueUp's id for this play, unique per play rather than per track. */
  id: string;
  playedAt: string | null;
  requestedAt: string;
  requester: { id: string; username: string } | null;
  provider: string;
  /**
   * The id the provider knows the track by. YouTube ids are video ids and make
   * a URL on their own; SoundCloud ids are numeric and have to be resolved
   * against SoundCloud before they name anything playable.
   */
  providerMediaId: string;
  /** QueUp's own id for the track, which is what repeat plays share. */
  songId: string;
  title: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  upvotes: number;
  downvotes: number;
  skipped: boolean;
}

export interface RoomExport {
  source: 'queup';
  exportedAt: string;
  room: {
    id: string;
    slug: string;
    name: string;
    description: string;
    createdAt: string;
    ownerUsername: string | null;
  };
  plays: ExportedPlay[];
  /** Everyone the room has a record of, with the counts QueUp keeps for them. */
  people: Array<{
    id: string;
    username: string;
    playedCount: number;
    skippedCount: number;
    banned: boolean;
    staff: boolean;
  }>;
  moderation: Array<{
    at: string;
    type: string;
    /** Seconds, for the actions that carry one. Zero when the action has no term. */
    duration: number;
    subject: { id: string; username: string } | null;
    moderator: { id: string; username: string } | null;
  }>;
}

async function get(path: string): Promise<unknown> {
  // The API is steady but not fast, and one failed page would otherwise punch a
  // hole in the middle of a 2,400-page history, so each page is retried.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
      });
      if (response.status === 302) {
        throw new Error(`${path} needs a session; this script only reads public room data.`);
      }
      if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
      const body = (await response.json()) as { code?: number; data?: unknown };
      if (body.code !== 200) throw new Error(`${path} answered code ${body.code}.`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

async function getList<Row = Record<string, unknown>>(path: string): Promise<Row[]> {
  const data = await get(path);
  return Array.isArray(data) ? (data as Row[]) : [];
}

function asDate(value: number | null | undefined): string | null {
  return typeof value === 'number' && value > 0 ? new Date(value).toISOString() : null;
}

function toPlay(entry: QueupPlay): ExportedPlay | null {
  const song = entry._song;
  // A play whose track has since been deleted from QueUp's catalogue names
  // nothing importable, so it is dropped rather than carried as a hole.
  if (!song?.fkid || !song.type) return null;
  return {
    id: entry._id,
    playedAt: asDate(entry.played),
    requestedAt: asDate(entry.created) ?? new Date(0).toISOString(),
    requester: entry._user ? { id: entry._user._id, username: entry._user.username } : null,
    provider: song.type,
    providerMediaId: song.fkid,
    songId: song._id,
    title: song.name,
    durationSeconds: Math.round((song.songLength ?? 0) / 1000),
    thumbnailUrl: song.images?.thumbnail ?? null,
    upvotes: entry.updubs ?? 0,
    downvotes: entry.downdubs ?? 0,
    skipped: Boolean(entry.skipped),
  };
}

/**
 * Walks the history newest first until a page comes back short, which is how
 * this API says there is no more.
 *
 * Pages are offsets into a list that grows at the front, so a track played
 * while the export runs shifts everything back by one and a play can arrive
 * twice. Ids are kept in a set for that reason: the duplicate is dropped and
 * the count is reported, rather than the export quietly holding the same play
 * twice.
 */
async function fetchHistory(roomId: string, pageLimit: number): Promise<{
  plays: ExportedPlay[];
  duplicates: number;
  dropped: number;
}> {
  const plays: ExportedPlay[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let dropped = 0;
  let page = 1;
  let done = false;

  while (!done && page <= pageLimit) {
    const batch = Array.from({ length: CONCURRENCY }, (_, index) => page + index).filter(
      (candidate) => candidate <= pageLimit,
    );
    const pages = await Promise.all(
      batch.map((candidate) =>
        getList<QueupPlay>(`/room/${roomId}/playlist/history?page=${candidate}`),
      ),
    );

    for (const entries of pages) {
      for (const entry of entries) {
        if (seen.has(entry._id)) {
          duplicates += 1;
          continue;
        }
        seen.add(entry._id);
        const play = toPlay(entry);
        if (play) plays.push(play);
        else dropped += 1;
      }
      if (entries.length < PAGE_SIZE) done = true;
    }

    page += batch.length;
    process.stdout.write(`\r  history: ${plays.length} plays (page ${page - 1})   `);
  }
  process.stdout.write('\n');

  return { plays, duplicates, dropped };
}

function person(entry: Record<string, unknown>): { id: string; username: string } | null {
  const user = entry as { _id?: string; username?: string } | null;
  return user?._id && user.username ? { id: user._id, username: user.username } : null;
}

export async function exportRoom(roomRef: string, pageLimit: number): Promise<RoomExport> {
  const room = (await get(`/room/${roomRef}`)) as {
    _id: string;
    roomUrl: string;
    name: string;
    description: string;
    created: number;
    _user?: QueupUser | null;
  };
  console.log(`Room "${room.name}" (${room.roomUrl}), id ${room._id}`);

  const [members, banned, staff, audit] = await Promise.all([
    getList(`/room/${room._id}/users`),
    getList(`/room/${room._id}/users/ban`),
    getList(`/room/${room._id}/users/staff`),
    getList(`/room/${room._id}/audit`),
  ]);
  console.log(
    `  ${members.length} present, ${banned.length} banned, ${staff.length} staff, ${audit.length} moderation records`,
  );

  const { plays, duplicates, dropped } = await fetchHistory(room._id, pageLimit);
  if (duplicates > 0) {
    console.log(`  ${duplicates} duplicate rows dropped (the room played while this ran)`);
  }
  if (dropped > 0) console.log(`  ${dropped} plays skipped: the track no longer exists on QueUp`);

  // The three member lists overlap and each one is partial: `users` is whoever
  // is in the room now, so the history is the only place most people appear at
  // all. They are folded into one roster keyed by QueUp's user id.
  const people = new Map<string, RoomExport['people'][number]>();
  const remember = (
    entry: Record<string, unknown>,
    flags: { banned?: boolean; staff?: boolean } = {},
  ) => {
    const user = person(entry._user as Record<string, unknown>);
    if (!user) return;
    const existing = people.get(user.id);
    people.set(user.id, {
      id: user.id,
      username: user.username,
      playedCount: Number(entry.playedCount ?? existing?.playedCount ?? 0),
      skippedCount: Number(entry.skippedCount ?? existing?.skippedCount ?? 0),
      banned: flags.banned ?? existing?.banned ?? false,
      staff: flags.staff ?? existing?.staff ?? false,
    });
  };
  for (const entry of members) remember(entry);
  for (const entry of staff) remember(entry, { staff: true });
  for (const entry of banned) remember(entry, { banned: true });
  for (const play of plays) {
    if (play.requester && !people.has(play.requester.id)) {
      people.set(play.requester.id, {
        id: play.requester.id,
        username: play.requester.username,
        playedCount: 0,
        skippedCount: 0,
        banned: false,
        staff: false,
      });
    }
  }

  return {
    source: 'queup',
    exportedAt: new Date().toISOString(),
    room: {
      id: room._id,
      slug: room.roomUrl,
      name: room.name,
      description: room.description ?? '',
      createdAt: asDate(room.created) ?? new Date(0).toISOString(),
      ownerUsername: room._user?.username ?? null,
    },
    plays,
    people: [...people.values()].sort((a, b) => b.playedCount - a.playedCount),
    moderation: (audit as Array<Record<string, unknown>>).map((entry) => ({
      at: asDate(entry.created as number) ?? new Date(0).toISOString(),
      type: String(entry.type ?? 'unknown'),
      duration: Number(entry.duration ?? 0),
      subject: person(entry._user as Record<string, unknown>),
      moderator: person(entry._mod as Record<string, unknown>),
    })),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const roomRef = args.find((arg) => !arg.startsWith('--'));
  if (!roomRef) {
    console.error('Usage: npx tsx scripts/queup-export-room.ts <room-slug-or-id> [--out file.json] [--pages n]');
    process.exit(1);
  }
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  const pageLimit = Number(option('pages') ?? Number.POSITIVE_INFINITY);
  const out = option('out') ?? `queup-${roomRef}.json`;

  const exported = await exportRoom(roomRef, pageLimit);
  await writeFile(out, JSON.stringify(exported, null, 1), 'utf8');

  const oldest = exported.plays.at(-1)?.playedAt ?? null;
  const providers = new Map<string, number>();
  for (const play of exported.plays) {
    providers.set(play.provider, (providers.get(play.provider) ?? 0) + 1);
  }
  console.log(`\nWrote ${out}`);
  console.log(`  ${exported.plays.length} plays back to ${oldest ?? 'unknown'}`);
  console.log(`  ${new Set(exported.plays.map((play) => play.songId)).size} distinct tracks`);
  console.log(`  ${exported.people.length} people`);
  console.log(`  by provider: ${[...providers].map(([name, count]) => `${name} ${count}`).join(', ')}`);
}

await main();
