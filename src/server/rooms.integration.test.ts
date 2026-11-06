import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '../shared/contracts';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const {
  createRoom: createOwnedRoom,
  findRoomIdBySlug,
  listRoomModerators,
  listRooms,
  MAIN_ROOM_ID,
  roomAccessOf,
  roomRoleOf,
  setRoomModerator,
} = await import('./rooms');
const schema = await import('./db/schema');
const { roomMembers, rooms, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('room roles', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${roomMembers}, ${users} cascade`);
    await db.delete(rooms).where(sql`${rooms.id} <> ${MAIN_ROOM_ID}`);
  });

  async function createUser(username: string, role: UserRole = 'listener') {
    const [row] = await db
      .insert(users)
      .values({ dggUserId: `dgg-${username}`, username, role, dggStatus: 'active' })
      .returning();
    if (!row) throw new Error('Could not create the test user');
    return row;
  }

  async function createRoom(slug: string) {
    const [room] = await db.insert(rooms).values({ slug, name: slug }).returning();
    if (!room) throw new Error('Could not create the test room');
    return room.id;
  }

  it('finds the main room by its slug, whatever the case', async () => {
    expect(await findRoomIdBySlug('main', db)).toBe(MAIN_ROOM_ID);
    expect(await findRoomIdBySlug('MAIN', db)).toBe(MAIN_ROOM_ID);
    expect(await findRoomIdBySlug('nowhere', db)).toBeNull();
  });

  it('treats a site admin as the owner of every room', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const other = await createRoom('other');

    expect(await roomRoleOf(admin, MAIN_ROOM_ID, db)).toBe('owner');
    expect(await roomRoleOf(admin, other, db)).toBe('owner');
  });

  it('makes a moderator of one room and nothing in another', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const listener = await createUser('swagy_swagerson');
    const other = await createRoom('other');

    expect(await roomRoleOf(listener, MAIN_ROOM_ID, db)).toBeNull();
    await setRoomModerator(MAIN_ROOM_ID, listener.username, true, admin, db);
    expect(await roomRoleOf(listener, MAIN_ROOM_ID, db)).toBe('mod');
    expect(await roomRoleOf(listener, other, db)).toBeNull();

    await setRoomModerator(MAIN_ROOM_ID, listener.username, false, admin, db);
    expect(await roomRoleOf(listener, MAIN_ROOM_ID, db)).toBeNull();
  });

  it('can be asked twice without minding', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const listener = await createUser('swagy_swagerson');

    await setRoomModerator(MAIN_ROOM_ID, listener.username, true, admin, db);
    await setRoomModerator(MAIN_ROOM_ID, listener.username, true, admin, db);
    expect(await roomRoleOf(listener, MAIN_ROOM_ID, db)).toBe('mod');
  });

  it('never unseats an owner by unticking them as a mod', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const owner = await createUser('room_owner');
    const other = await createRoom('other');
    await db.insert(roomMembers).values({ roomId: other, userId: owner.id, role: 'owner' });

    await expect(setRoomModerator(other, owner.username, false, admin, db)).rejects.toMatchObject({
      code: 'ROOM_OWNER',
    });
    expect(await roomRoleOf(owner, other, db)).toBe('owner');
  });

  it('answers nothing for nobody', async () => {
    expect(await roomRoleOf(null, MAIN_ROOM_ID, db)).toBeNull();
  });

  describe('creating a room', () => {
    it('refuses anyone a site admin has not whitelisted', async () => {
      const listener = await createUser('swagy_swagerson');
      await expect(
        createOwnedRoom({ slug: 'late-night', name: 'Late Night' }, listener, db),
      ).rejects.toMatchObject({ code: 'ROOM_CREATOR_REQUIRED' });
    });

    it('makes a whitelisted creator the owner of a new room with nothing in it', async () => {
      const creator = await createUser('room_maker');
      await db.update(users).set({ canCreateRooms: true }).where(sql`${users.id} = ${creator.id}`);

      const room = await createOwnedRoom({ slug: 'Late-Night', name: ' Late Night ' }, creator, db);

      expect(room).toEqual({ slug: 'late-night', name: 'Late Night' });
      const roomId = await findRoomIdBySlug('late-night', db);
      expect(await roomRoleOf(creator, roomId!, db)).toBe('owner');
      expect(await listRoomModerators(roomId!, db)).toEqual([
        { id: creator.id, username: 'room_maker', role: 'owner' },
      ]);
      expect((await listRooms(db)).map(({ slug }) => slug)).toEqual(['main', 'late-night']);
    });

    it('lets an owner have one room, and says so before they try for another', async () => {
      const creator = await createUser('room_maker');
      await db.update(users).set({ canCreateRooms: true }).where(sql`${users.id} = ${creator.id}`);

      await createOwnedRoom({ slug: 'late-night', name: 'Late Night' }, creator, db);

      expect((await roomAccessOf(creator, db)).canCreate).toBe(false);
      await expect(
        createOwnedRoom({ slug: 'early-morning', name: 'Early Morning' }, creator, db),
      ).rejects.toMatchObject({ code: 'ROOM_LIMIT' });
    });

    it('keeps the main room\'s name, and every name, to one room', async () => {
      const admin = await createUser('picklesnathan', 'admin');
      const other = await createUser('room_maker');
      await db.update(users).set({ canCreateRooms: true }).where(sql`${users.id} = ${other.id}`);

      await expect(createOwnedRoom({ slug: 'main', name: 'Main' }, admin, db)).rejects.toMatchObject({
        code: 'ROOM_EXISTS',
      });
      await createOwnedRoom({ slug: 'late-night', name: 'Late Night' }, admin, db);
      await expect(
        createOwnedRoom({ slug: 'late-night', name: 'Also Late' }, other, db),
      ).rejects.toMatchObject({ code: 'ROOM_EXISTS' });
    });

    it('makes a moderator by name, however it is capitalised, and nobody unknown', async () => {
      const admin = await createUser('picklesnathan', 'admin');
      const listener = await createUser('Swagy_Swagerson');

      await setRoomModerator(MAIN_ROOM_ID, 'swagy_swagerson', true, admin, db);
      expect(await roomRoleOf(listener, MAIN_ROOM_ID, db)).toBe('mod');
      await expect(
        setRoomModerator(MAIN_ROOM_ID, 'never_signed_in', true, admin, db),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });
  });
});
