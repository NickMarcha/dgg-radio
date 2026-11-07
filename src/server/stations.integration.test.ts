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
  createStation: createOwnedStation,
  findStationIdBySlug,
  listStationModerators,
  listStations,
  MAIN_STATION_ID,
  stationAccessOf,
  stationRoleOf,
  setStationModerator,
} = await import('./stations');
const schema = await import('./db/schema');
const { stationMembers, stations, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('station roles', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${stationMembers}, ${users} cascade`);
    await db.delete(stations).where(sql`${stations.id} <> ${MAIN_STATION_ID}`);
  });

  async function createUser(username: string, role: UserRole = 'listener') {
    const [row] = await db
      .insert(users)
      .values({ dggUserId: `dgg-${username}`, username, role, dggStatus: 'active' })
      .returning();
    if (!row) throw new Error('Could not create the test user');
    return row;
  }

  async function createStation(slug: string) {
    const [station] = await db.insert(stations).values({ slug, name: slug }).returning();
    if (!station) throw new Error('Could not create the test station');
    return station.id;
  }

  it('finds the main station by its slug, whatever the case', async () => {
    expect(await findStationIdBySlug('main', db)).toBe(MAIN_STATION_ID);
    expect(await findStationIdBySlug('MAIN', db)).toBe(MAIN_STATION_ID);
    expect(await findStationIdBySlug('nowhere', db)).toBeNull();
  });

  it('treats a site admin as the owner of every station', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const other = await createStation('other');

    expect(await stationRoleOf(admin, MAIN_STATION_ID, db)).toBe('owner');
    expect(await stationRoleOf(admin, other, db)).toBe('owner');
  });

  it('makes a moderator of one station and nothing in another', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const listener = await createUser('swagy_swagerson');
    const other = await createStation('other');

    expect(await stationRoleOf(listener, MAIN_STATION_ID, db)).toBeNull();
    await setStationModerator(MAIN_STATION_ID, listener.username, true, admin, db);
    expect(await stationRoleOf(listener, MAIN_STATION_ID, db)).toBe('mod');
    expect(await stationRoleOf(listener, other, db)).toBeNull();

    await setStationModerator(MAIN_STATION_ID, listener.username, false, admin, db);
    expect(await stationRoleOf(listener, MAIN_STATION_ID, db)).toBeNull();
  });

  it('can be asked twice without minding', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const listener = await createUser('swagy_swagerson');

    await setStationModerator(MAIN_STATION_ID, listener.username, true, admin, db);
    await setStationModerator(MAIN_STATION_ID, listener.username, true, admin, db);
    expect(await stationRoleOf(listener, MAIN_STATION_ID, db)).toBe('mod');
  });

  it('never unseats an owner by unticking them as a mod', async () => {
    const admin = await createUser('picklesnathan', 'admin');
    const owner = await createUser('station_owner');
    const other = await createStation('other');
    await db.insert(stationMembers).values({ stationId: other, userId: owner.id, role: 'owner' });

    await expect(setStationModerator(other, owner.username, false, admin, db)).rejects.toMatchObject({
      code: 'STATION_OWNER',
    });
    expect(await stationRoleOf(owner, other, db)).toBe('owner');
  });

  it('answers nothing for nobody', async () => {
    expect(await stationRoleOf(null, MAIN_STATION_ID, db)).toBeNull();
  });

  describe('creating a station', () => {
    it('refuses anyone a site admin has not whitelisted', async () => {
      const listener = await createUser('swagy_swagerson');
      await expect(
        createOwnedStation({ slug: 'late-night', name: 'Late Night' }, listener, db),
      ).rejects.toMatchObject({ code: 'STATION_CREATOR_REQUIRED' });
    });

    it('makes a whitelisted creator the owner of a new station with nothing in it', async () => {
      const creator = await createUser('station_maker');
      await db.update(users).set({ canCreateStations: true }).where(sql`${users.id} = ${creator.id}`);

      const station = await createOwnedStation({ slug: 'Late-Night', name: ' Late Night ' }, creator, db);

      expect(station).toEqual({ slug: 'late-night', name: 'Late Night' });
      const stationId = await findStationIdBySlug('late-night', db);
      expect(await stationRoleOf(creator, stationId!, db)).toBe('owner');
      expect(await listStationModerators(stationId!, db)).toEqual([
        { id: creator.id, username: 'station_maker', role: 'owner' },
      ]);
      expect((await listStations(db)).map(({ slug }) => slug)).toEqual(['main', 'late-night']);
    });

    it('lets an owner have one station, and says so before they try for another', async () => {
      const creator = await createUser('station_maker');
      await db.update(users).set({ canCreateStations: true }).where(sql`${users.id} = ${creator.id}`);

      await createOwnedStation({ slug: 'late-night', name: 'Late Night' }, creator, db);

      expect((await stationAccessOf(creator, db)).canCreate).toBe(false);
      await expect(
        createOwnedStation({ slug: 'early-morning', name: 'Early Morning' }, creator, db),
      ).rejects.toMatchObject({ code: 'STATION_LIMIT' });
    });

    it('keeps the main station\'s name, and every name, to one station', async () => {
      const admin = await createUser('picklesnathan', 'admin');
      const other = await createUser('station_maker');
      await db.update(users).set({ canCreateStations: true }).where(sql`${users.id} = ${other.id}`);

      await expect(createOwnedStation({ slug: 'main', name: 'Main' }, admin, db)).rejects.toMatchObject({
        code: 'STATION_EXISTS',
      });
      await createOwnedStation({ slug: 'late-night', name: 'Late Night' }, admin, db);
      await expect(
        createOwnedStation({ slug: 'late-night', name: 'Also Late' }, other, db),
      ).rejects.toMatchObject({ code: 'STATION_EXISTS' });
    });

    it('makes a moderator by name, however it is capitalised, and nobody unknown', async () => {
      const admin = await createUser('picklesnathan', 'admin');
      const listener = await createUser('Swagy_Swagerson');

      await setStationModerator(MAIN_STATION_ID, 'swagy_swagerson', true, admin, db);
      expect(await stationRoleOf(listener, MAIN_STATION_ID, db)).toBe('mod');
      await expect(
        setStationModerator(MAIN_STATION_ID, 'never_signed_in', true, admin, db),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });
  });
});
