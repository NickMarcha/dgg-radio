import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { listPlaybackRegions, RegionLookupError } = await import('./regions');
const schema = await import('./db/schema');
const { playbackRegions } = schema;

const connectionString = testConnectionString();

function respond(items: { gl: string; name: string }[]): typeof fetch {
  return vi.fn(async () =>
    Response.json({ items: items.map((snippet) => ({ snippet })) }),
  ) as unknown as typeof fetch;
}

const refused = () =>
  vi.fn(async () => new Response('quota', { status: 403 })) as unknown as typeof fetch;

describe.skipIf(!connectionString)('playback region cache', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${playbackRegions}`);
  });

  it('stores the codes and names, and returns them sorted by name', async () => {
    const fetcher = respond([
      { gl: 'ZW', name: 'Zimbabwe' },
      { gl: 'AE', name: 'United Arab Emirates' },
      { gl: 'AL', name: 'Albania' },
    ]);

    expect(await listPlaybackRegions(fetcher, db)).toEqual([
      { code: 'AL', name: 'Albania' },
      { code: 'AE', name: 'United Arab Emirates' },
      { code: 'ZW', name: 'Zimbabwe' },
    ]);
    expect(await db.select().from(playbackRegions)).toHaveLength(3);
  });

  it('asks YouTube once and serves later calls from the table', async () => {
    const fetcher = respond([{ gl: 'AE', name: 'United Arab Emirates' }]);

    await listPlaybackRegions(fetcher, db);
    const second = await listPlaybackRegions(fetcher, db);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(second).toEqual([{ code: 'AE', name: 'United Arab Emirates' }]);
  });

  it('serves a list stored before this process started, so a restart costs nothing', async () => {
    await db
      .insert(playbackRegions)
      .values([{ code: 'AE', name: 'United Arab Emirates', fetchedAt: new Date() }]);

    const fetcher = respond([{ gl: 'AE', name: 'United Arab Emirates' }]);

    expect(await listPlaybackRegions(fetcher, db)).toEqual([
      { code: 'AE', name: 'United Arab Emirates' },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks again once the stored list is a month old', async () => {
    await listPlaybackRegions(respond([{ gl: 'AE', name: 'United Arab Emirates' }]), db);
    await db.update(playbackRegions).set({
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000),
    });

    const fetcher = respond([
      { gl: 'AE', name: 'United Arab Emirates' },
      { gl: 'AL', name: 'Albania' },
    ]);
    expect(await listPlaybackRegions(fetcher, db)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('drops a region YouTube has withdrawn', async () => {
    await listPlaybackRegions(
      respond([
        { gl: 'AE', name: 'United Arab Emirates' },
        { gl: 'AL', name: 'Albania' },
      ]),
      db,
    );
    await db.update(playbackRegions).set({
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000),
    });

    await listPlaybackRegions(respond([{ gl: 'AE', name: 'United Arab Emirates' }]), db);

    expect((await db.select().from(playbackRegions)).map(({ code }) => code)).toEqual(['AE']);
  });

  it('keeps serving the stored list when YouTube refuses', async () => {
    await listPlaybackRegions(respond([{ gl: 'AE', name: 'United Arab Emirates' }]), db);
    await db.update(playbackRegions).set({
      fetchedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000),
    });

    await expect(listPlaybackRegions(refused(), db)).rejects.toBeInstanceOf(RegionLookupError);
    expect(await db.select().from(playbackRegions)).toHaveLength(1);
  });
});
