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

const { getStreamWatchSettings, updateStreamWatchSettings, watchTracker } = await import(
  './watchers'
);
const schema = await import('./db/schema');
const { MAIN_ROOM_ID } = await import('./rooms');
const { streamWatch, users } = schema;

const connectionString = testConnectionString();

describe.skipIf(!connectionString)('stream watch settings', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    // Nothing ever connected: the settings start disabled and every case here
    // leaves them that way.
    watchTracker.stop();
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(
      sql`truncate table ${streamWatch}, ${users} cascade`,
    );
    await db.delete(schema.rooms).where(sql`${schema.rooms.id} <> ${MAIN_ROOM_ID}`);
  });

  async function createAdmin() {
    const [row] = await db
      .insert(users)
      .values({
        dggUserId: 'dgg-picklesnathan',
        username: 'picklesnathan',
        role: 'admin',
        dggStatus: 'Active',
      })
      .returning({ id: users.id });
    return row!.id;
  }

  it('starts switched off, so nothing connects until an admin asks for it', async () => {
    const settings = await getStreamWatchSettings(MAIN_ROOM_ID, db);
    expect(settings).toMatchObject({ enabled: false, platform: 'kick', channel: '' });
  });

  it('stores the channel lowercase, however an admin types it', async () => {
    const userId = await createAdmin();
    // The bigscreen link is written #kick/dggJams; chat reports it lowercase.
    const settings = await updateStreamWatchSettings(MAIN_ROOM_ID, { channel: '  dggJams ' }, userId, db);
    expect(settings.channel).toBe('dggjams');
  });

  it('keeps the settings it was not asked to change', async () => {
    const userId = await createAdmin();
    await updateStreamWatchSettings(MAIN_ROOM_ID, { platform: 'twitch', channel: 'someone' }, userId, db);
    const settings = await updateStreamWatchSettings(MAIN_ROOM_ID, { enabled: true }, userId, db);
    expect(settings).toMatchObject({ enabled: true, platform: 'twitch', channel: 'someone' });
  });

  it('records who changed it', async () => {
    const userId = await createAdmin();
    await updateStreamWatchSettings(MAIN_ROOM_ID, { enabled: false }, userId, db);
    const [row] = await db.select().from(streamWatch);
    expect(row.updatedByUserId).toBe(userId);
  });

  it('reports no channel while nothing is being watched', () => {
    expect(watchTracker.snapshot(MAIN_ROOM_ID)).toMatchObject({
      channel: null,
      live: false,
      siteCount: null,
      chatCount: 0,
      watchers: [],
    });
  });

  it("keeps each room's stream to itself", async () => {
    const userId = await createAdmin();
    const [other] = await db
      .insert(schema.rooms)
      .values({ slug: 'other', name: 'Other' })
      .returning({ id: schema.rooms.id });

    await updateStreamWatchSettings(MAIN_ROOM_ID, { channel: 'dggJams', enabled: true }, userId, db);
    await updateStreamWatchSettings(other!.id, { channel: 'Destiny' }, userId, db);

    expect(await getStreamWatchSettings(MAIN_ROOM_ID, db)).toMatchObject({
      enabled: true,
      channel: 'dggjams',
    });
    expect(await getStreamWatchSettings(other!.id, db)).toMatchObject({
      enabled: false,
      channel: 'destiny',
    });
  });

  it('reports no channel for a room that follows none', () => {
    expect(watchTracker.snapshot('00000000-0000-4000-8000-0000000000ff').channel).toBeNull();
  });
});
