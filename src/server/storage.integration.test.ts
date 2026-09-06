import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StorageSnapshot } from '../shared/contracts';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { getStorageSnapshot, STORAGE_TABLES } = await import('./storage');
const schema = await import('./db/schema');
const { media, playlistItems, playlists, users } = schema;

const connectionString = testConnectionString();

const GROUP_NAMES = [
  'Accounts and authentication',
  'Embed history and overlay',
  'Genre labels',
  'History and voting',
  'Personal playlists',
  'QueUp archive',
  'Room state and internal tables',
  'Rules and moderation',
  'Track catalogue and provider cache',
];

function group(snapshot: StorageSnapshot, name: string) {
  const found = snapshot.groups.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No storage group named "${name}"`);
  return found;
}

/**
 * Every table the schema declares, read from the schema itself rather than
 * listed here. A list would need the same maintenance as the one it is checking.
 */
function schemaTables(): string[] {
  return Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => getTableName(table as PgTable))
    .sort();
}

describe('what the storage page accounts for', () => {
  it('files every table in the schema into exactly one group', () => {
    // The page ends by saying the unmeasured remainder is PostgreSQL's own
    // overhead. A table nobody filed makes that sentence wrong rather than
    // incomplete: `track_genres` went unfiled for long enough to become the
    // second largest table in the database, and the page called its 23.9%
    // catalogues. This fails the moment a migration adds a table.
    const filed = STORAGE_TABLES.filter((name) => !name.includes('.')).sort();

    expect(filed).toEqual(schemaTables());
    // And no table is counted twice, which would claim more than exists.
    expect(new Set(STORAGE_TABLES).size).toBe(STORAGE_TABLES.length);
  });
});

describe.skipIf(!connectionString)('database storage snapshot', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(
      sql`truncate table ${playlistItems}, ${playlists}, ${media}, ${users} restart identity cascade`,
    );
  });

  async function saveTrack(providerMediaId: string, owner: string) {
    const [user] = await db
      .insert(users)
      .values({ dggUserId: `dgg-${owner}`, username: owner, dggStatus: 'active' })
      .returning({ id: users.id });
    const [track] = await db
      .insert(media)
      .values({
        provider: 'youtube',
        providerMediaId,
        providerArtistId: `channel-${providerMediaId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${providerMediaId}`,
        title: `Track ${providerMediaId}`,
        artist: 'Test Artist',
        durationSeconds: 120,
        thumbnailUrl: null,
      })
      .returning({ id: media.id });
    if (!user || !track) throw new Error('Could not seed the storage test');

    const [playlist] = await db
      .insert(playlists)
      .values({ ownerUserId: user.id, name: 'Driving' })
      .returning({ id: playlists.id });
    if (!playlist) throw new Error('Could not seed the storage test');
    await db.insert(playlistItems).values({ playlistId: playlist.id, mediaId: track.id, position: 0 });
  }

  it('measures the whole database and every named group', async () => {
    const snapshot = await getStorageSnapshot(db);

    expect(snapshot.databaseBytes).toBeGreaterThan(0);
    expect(snapshot.groups.map(({ name }) => name).sort()).toEqual(GROUP_NAMES);

    for (const measured of snapshot.groups) {
      expect(measured.tableBytes + measured.indexBytes).toBe(measured.totalBytes);
      expect(measured.share).toBeCloseTo(measured.totalBytes / snapshot.databaseBytes);
    }
  });

  it('orders groups by what they take, and never claims more than the database', async () => {
    const snapshot = await getStorageSnapshot(db);

    const sizes = snapshot.groups.map(({ totalBytes }) => totalBytes);
    expect(sizes).toEqual([...sizes].sort((first, second) => second - first));

    const claimed = snapshot.groups.reduce((total, measured) => total + measured.share, 0);
    expect(claimed).toBeGreaterThan(0);
    expect(claimed).toBeLessThanOrEqual(1);
  });

  it('files a saved track under the catalogue once and the playlist once', async () => {
    // The row counts are PostgreSQL's estimates, which the statistics collector
    // updates in its own time. Analysing first makes them current, so what is
    // being asserted here is the grouping — a shared `media` row belongs to the
    // catalogue rather than to everyone who saved it — and not the counting.
    const snapshotNow = async () => {
      await db.execute(sql`analyze`);
      return getStorageSnapshot(db);
    };

    const before = await snapshotNow();
    await saveTrack('aaaaaaaaaaa', 'owner');
    const after = await snapshotNow();

    const rows = (snapshot: StorageSnapshot, name: string) => group(snapshot, name).rowCount;

    // The playlist and its one item, with the shared media row left to the
    // catalogue rather than counted against the owner.
    expect(rows(after, 'Personal playlists') - rows(before, 'Personal playlists')).toBe(2);
    expect(
      rows(after, 'Track catalogue and provider cache') -
        rows(before, 'Track catalogue and provider cache'),
    ).toBe(1);
    expect(rows(after, 'Accounts and authentication') - rows(before, 'Accounts and authentication')).toBe(1);
  });

  it("leaves only PostgreSQL's own overhead unmeasured", async () => {
    const snapshot = await getStorageSnapshot(db);

    const measured = snapshot.groups.reduce((total, group) => total + group.totalBytes, 0);
    const unmeasured = snapshot.databaseBytes - measured;

    // Catalogues and the room PostgreSQL keeps inside its own files. It is a
    // fixed cost of a few megabytes rather than a share of the data, so on a
    // database holding anything at all it cannot be most of the total.
    expect(unmeasured).toBeGreaterThanOrEqual(0);
    expect(unmeasured).toBeLessThan(snapshot.databaseBytes);
  });

  it('reaches the migrations table outside the public schema', async () => {
    const internal = group(await getStorageSnapshot(db), 'Room state and internal tables');

    expect(internal.tables).toContain('drizzle.__drizzle_migrations');
    expect(internal.rowCount).toBeGreaterThan(0);
    expect(internal.totalBytes).toBeGreaterThan(0);
  });
});
