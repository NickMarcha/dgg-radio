import { and, eq } from 'drizzle-orm';
import type { RoomRole } from '../shared/contracts';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { roomMembers, rooms, users } from './db/schema';

/**
 * The room at `/`. Its id is fixed by the migration that created `rooms`, so
 * the main room can be named without a lookup.
 */
export const MAIN_ROOM_ID = '00000000-0000-4000-8000-000000000001';

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
 * Adds or removes one of a room's moderators. An owner's row is left alone:
 * ownership changes hands some other way, never by unticking a box.
 */
export async function setRoomModerator(
  roomId: string,
  userId: string,
  moderator: boolean,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!target) throw new RoomAccessError('USER_NOT_FOUND', 'That user does not exist.', 404);

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
