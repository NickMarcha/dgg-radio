import { and, asc, eq, sql } from 'drizzle-orm';
import type { OwnedRoom, RoomListing, RoomModerator, RoomRole } from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import {
  media,
  queueItems,
  roomMembers,
  rooms,
  roomSettings,
  roomState,
  streamWatch,
  users,
} from './db/schema';

/**
 * The room at `/`. Its id is fixed by the migration that created `rooms`, so
 * the main room can be named without a lookup.
 */
export const MAIN_ROOM_ID = '00000000-0000-4000-8000-000000000001';

/** Either the pool or an open transaction on it. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export class RoomAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'RoomAccessError';
  }
}

/**
 * What a user may do in a room. A site admin acts as an owner everywhere,
 * without a membership row, so the room cannot be locked away from them.
 */
export async function roomRoleOf(
  user: Pick<AuthenticatedUser, 'id' | 'role'> | null,
  roomId: string,
  db: Database = getDatabase(),
): Promise<RoomRole | null> {
  if (!user) return null;
  if (user.role === 'admin') return 'owner';
  const [member] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)));
  return member?.role ?? null;
}

/** Owners and mods both moderate. */
export function canModerateRoom(role: RoomRole | null): boolean {
  return role !== null;
}

/** Only an owner changes the room itself, its rules, and who moderates it. */
export function canManageRoom(role: RoomRole | null): boolean {
  return role === 'owner';
}

export async function findRoomIdBySlug(
  slug: string,
  db: Database = getDatabase(),
): Promise<string | null> {
  const [room] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.slug, slug.toLowerCase()));
  return room?.id ?? null;
}

/**
 * How many rooms one person may own. The schema allows any number; this is the
 * only thing to change when owners may run more than one.
 */
export const MAX_ROOMS_PER_OWNER = 1;

/** Taken by the room at `/`, so nobody else can claim it. */
const RESERVED_SLUGS = new Set(['main']);

/** Every room, the main one first and the rest by age, with what each is playing. */
export async function listRooms(
  db: Database = getDatabase(),
): Promise<(Omit<RoomListing, 'listenerCount'> & { id: string })[]> {
  const rows = await db
    .select({
      id: rooms.id,
      slug: rooms.slug,
      name: rooms.name,
      title: media.title,
      artist: media.artist,
    })
    .from(rooms)
    .leftJoin(roomState, eq(roomState.roomId, rooms.id))
    .leftJoin(queueItems, eq(queueItems.id, roomState.currentQueueItemId))
    .leftJoin(media, eq(media.id, queueItems.mediaId))
    .orderBy(sql`${rooms.id} <> ${MAIN_ROOM_ID}`, asc(rooms.createdAt));
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    nowPlaying: row.title === null ? null : { title: row.title, artist: row.artist ?? '' },
  }));
}

/** The rooms a user owns, for the header to link them to. */
export async function ownedRooms(
  userId: string,
  db: Executor = getDatabase(),
): Promise<OwnedRoom[]> {
  return db
    .select({ slug: rooms.slug, name: rooms.name })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(and(eq(roomMembers.userId, userId), eq(roomMembers.role, 'owner')))
    .orderBy(asc(rooms.createdAt));
}

/** What the header needs to offer someone a room: the ones they own, and whether they may make one. */
export async function roomAccessOf(
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
  db: Database = getDatabase(),
): Promise<{ owned: OwnedRoom[]; canCreate: boolean }> {
  const [row] = await db
    .select({ canCreateRooms: users.canCreateRooms })
    .from(users)
    .where(eq(users.id, user.id));
  const owned = await ownedRooms(user.id, db);
  const allowed = user.role === 'admin' || Boolean(row?.canCreateRooms);
  return { owned, canCreate: allowed && owned.length < MAX_ROOMS_PER_OWNER };
}

/**
 * A new room, owned by whoever made it. Only someone a site admin has
 * whitelisted may, and only up to `MAX_ROOMS_PER_OWNER`. The room starts with
 * the default settings, no rules, and no stream.
 */
export async function createRoom(
  input: { slug: string; name: string },
  owner: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<OwnedRoom> {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  if (RESERVED_SLUGS.has(slug)) {
    throw new RoomAccessError('ROOM_EXISTS', 'That name is taken.', 409);
  }

  return db.transaction(async (transaction) => {
    const [creator] = await transaction
      .select({ canCreateRooms: users.canCreateRooms })
      .from(users)
      .where(eq(users.id, owner.id));
    if (!creator?.canCreateRooms && owner.role !== 'admin') {
      throw new RoomAccessError(
        'ROOM_CREATOR_REQUIRED',
        'Creating a room needs a site admin to allow it first.',
        403,
      );
    }
    // Serialised per owner, so two tabs cannot both slip under the limit.
    const lockKey = `room-owner:${owner.id}`;
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    if ((await ownedRooms(owner.id, transaction)).length >= MAX_ROOMS_PER_OWNER) {
      throw new RoomAccessError('ROOM_LIMIT', 'You already own a room.', 409);
    }

    const [room] = await transaction
      .insert(rooms)
      .values({ slug, name })
      .onConflictDoNothing()
      .returning({ id: rooms.id, slug: rooms.slug, name: rooms.name });
    if (!room) throw new RoomAccessError('ROOM_EXISTS', 'That name is taken.', 409);

    await transaction.insert(roomSettings).values({ roomId: room.id });
    await transaction.insert(roomState).values({ roomId: room.id });
    await transaction.insert(streamWatch).values({ roomId: room.id });
    await transaction
      .insert(roomMembers)
      .values({ roomId: room.id, userId: owner.id, role: 'owner', addedByUserId: owner.id });
    return { slug: room.slug, name: room.name };
  });
}

/** Who runs a room, owners first. */
export async function listRoomModerators(
  roomId: string,
  db: Database = getDatabase(),
): Promise<RoomModerator[]> {
  return db
    .select({ id: users.id, username: users.username, role: roomMembers.role })
    .from(roomMembers)
    .innerJoin(users, eq(users.id, roomMembers.userId))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.role), asc(users.username));
}

/**
 * Adds or removes one of a room's moderators. An owner's row is left alone:
 * ownership changes hands some other way, never by unticking a box.
 */
export async function setRoomModerator(
  roomId: string,
  username: string,
  moderator: boolean,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  // Somebody becomes known to the room by signing in once, so a name nobody
  // has signed in with yet cannot be made a moderator.
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username.trim()})`)
    .limit(1);
  if (!target) {
    throw new RoomAccessError(
      'USER_NOT_FOUND',
      'Nobody by that name has signed in to the radio yet.',
      404,
    );
  }
  const userId = target.id;

  const [current] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
  if (current?.role === 'owner') {
    throw new RoomAccessError('ROOM_OWNER', 'That user owns this room.', 409);
  }

  if (moderator) {
    await db
      .insert(roomMembers)
      .values({ roomId, userId, role: 'mod', addedByUserId: actor.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
  }
}
