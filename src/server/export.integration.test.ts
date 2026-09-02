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
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { EXPORTS, exportCsv, exportFilename } = await import('./export');
const schema = await import('./db/schema');
const { legacyPlays, trackGenres } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('exporting the room', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${trackGenres}, ${legacyPlays} restart identity cascade`);
  });

  /**
   * Seven queries that nothing else runs. A syntax error in any of them would
   * otherwise only surface the first time an admin clicked the link.
   */
  it.each(EXPORTS.map((dataset) => dataset.id))('builds the %s export', async (id) => {
    const csv = await exportCsv(id, db);
    const [header] = csv.split('\r\n');

    expect(header).toBeDefined();
    // Every column is quoted, so a header is quoted names separated by commas.
    expect(header).toMatch(/^"[a-z_]+"(,"[a-z_]+")*$/);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('quotes a value that would otherwise break the row apart', async () => {
    await db.insert(legacyPlays).values({
      sourceId: 'play-1',
      playedAt: new Date('2025-01-01T00:00:00.000Z'),
      requesterName: 'someone',
      provider: 'youtube',
      providerMediaId: 'video000001',
      title: 'A title, with a comma, a "quote" and\na newline',
      durationSeconds: 200,
    });

    const csv = await exportCsv('archive', db);

    // The quote is doubled and the whole value stays inside one pair of them.
    expect(csv).toContain('"A title, with a comma, a ""quote"" and\na newline"');
  });

  it('names the file after the day it was taken', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(exportFilename('archive')).toBe(`dgg-radio-archive-${today}.csv`);
  });
});
