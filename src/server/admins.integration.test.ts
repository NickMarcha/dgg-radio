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
// The environment is what makes someone a root admin.
process.env.ADMIN_DGG_USERNAMES = 'picklesnathan, StrawWaffle';

const { AdminError, isRootAdmin, listAdmins, listUsers, setUserRole } = await import('./admins');
const schema = await import('./db/schema');
const { media, queueItems, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('admin management', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${queueItems}, ${media}, ${users} cascade`);
  });

  async function createUser(username: string, role: UserRole = 'listener') {
    const [row] = await db
      .insert(users)
      .values({ dggUserId: `dgg-${username}`, username, role, dggStatus: 'Active' })
      .returning({ id: users.id });
    return row!.id;
  }

  it('reads root admins out of the environment, ignoring case', () => {
    expect(isRootAdmin('PicklesNathan')).toBe(true);
    expect(isRootAdmin('strawwaffle')).toBe(true);
    expect(isRootAdmin('someone_else')).toBe(false);
  });

  it('marks which admins came from the environment', async () => {
    await createUser('picklesnathan', 'admin');
    await createUser('promoted_mod', 'admin');
    await createUser('a_listener');

    const admins = await listAdmins(db);
    expect(admins.map(({ username, isRoot }) => [username, isRoot])).toEqual([
      ['picklesnathan', true],
      ['promoted_mod', false],
    ]);
  });

  it('promotes and demotes an ordinary user', async () => {
    const id = await createUser('promoted_mod');

    await setUserRole(id, 'mod', db);
    expect((await listUsers(undefined, db)).find((user) => user.id === id)?.role).toBe('mod');
    expect(await listAdmins(db)).toEqual([]);

    await setUserRole(id, 'admin', db);
    expect((await listAdmins(db)).map(({ username }) => username)).toEqual(['promoted_mod']);

    await setUserRole(id, 'listener', db);
    expect(await listAdmins(db)).toEqual([]);
  });

  it('refuses to demote a root admin', async () => {
    const id = await createUser('picklesnathan', 'admin');

    await expect(setUserRole(id, 'listener', db)).rejects.toMatchObject({ code: 'ROOT_ADMIN' });
    await expect(setUserRole(id, 'mod', db)).rejects.toMatchObject({ code: 'ROOT_ADMIN' });
    await expect(setUserRole(id, 'listener', db)).rejects.toBeInstanceOf(AdminError);
    expect((await listAdmins(db)).map(({ username }) => username)).toEqual(['picklesnathan']);
  });

  it('reports how much each person has waiting', async () => {
    const nathan = await createUser('picklesnathan', 'admin');
    const quiet = await createUser('quiet_listener');
    const [{ id: mediaId }] = await db
      .insert(schema.media)
      .values({
        provider: 'youtube',
        providerMediaId: 'dQw4w9WgXcQ',
        providerArtistId: 'UC-channel',
        canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'A Track',
        artist: 'An Artist',
        durationSeconds: 210,
      })
      .returning({ id: schema.media.id });
    await db.insert(queueItems).values({ mediaId: mediaId!, requestedByUserId: nathan });

    const listed = await listUsers(undefined, db);
    const counts = Object.fromEntries(listed.map((u) => [u.username, u.queuedCount]));
    expect(counts).toEqual({ picklesnathan: 1, quiet_listener: 0 });
    expect(listed.find((u) => u.id === quiet)?.isRoot).toBe(false);
  });

  it('searches by partial username', async () => {
    await createUser('picklesnathan');
    await createUser('swagy_swagerson');

    const found = await listUsers('waggy', db);
    expect(found).toEqual([]);
    const hit = await listUsers('swagy', db);
    expect(hit.map(({ username }) => username)).toEqual(['swagy_swagerson']);
  });
});
