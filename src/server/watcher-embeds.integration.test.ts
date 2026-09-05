import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const {
  findWatcherEmbedSettings,
  getOrCreateWatcherEmbedSettings,
  updateWatcherEmbedSettings,
} = await import('./watcher-embeds');
const schema = await import('./db/schema');
const { users, watcherEmbedSettings } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('personal watcher sources', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${watcherEmbedSettings}, ${users} cascade`);
  });

  async function createAdmin(username: string) {
    const [row] = await db
      .insert(users)
      .values({
        dggUserId: `dgg-${username}`,
        username,
        role: 'admin',
        dggStatus: 'Active',
      })
      .returning({ id: users.id });
    return row!.id;
  }

  it('creates one source with the same defaults as a fixed URL', async () => {
    const ownerId = await createAdmin('one');

    await expect(getOrCreateWatcherEmbedSettings(ownerId, db)).resolves.toMatchObject({
      ownerId,
      show: 'speakers',
      window: 10,
      max: 12,
      layout: 'float',
      names: 'under',
      enter: 'fade',
    });
  });

  it('keeps each admin settings separate', async () => {
    const firstId = await createAdmin('one');
    const secondId = await createAdmin('two');

    await updateWatcherEmbedSettings(firstId, { layout: 'climb', max: 8 }, db);
    await updateWatcherEmbedSettings(secondId, { layout: 'safe', names: 'off' }, db);

    await expect(findWatcherEmbedSettings(firstId, db)).resolves.toMatchObject({
      layout: 'climb',
      max: 8,
      names: 'under',
    });
    await expect(findWatcherEmbedSettings(secondId, db)).resolves.toMatchObject({
      layout: 'safe',
      max: 12,
      names: 'off',
    });
  });

  it('does not create settings while reading an unknown public id', async () => {
    const ownerId = crypto.randomUUID();

    await expect(findWatcherEmbedSettings(ownerId, db)).resolves.toBeNull();
    await expect(db.select().from(watcherEmbedSettings)).resolves.toEqual([]);
  });
});
