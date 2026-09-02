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
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { listLegacyHistory } = await import('./legacy');
const schema = await import('./db/schema');
const { legacyPlays } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('the QueUp archive', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
    // Unlike the other tables here, this one is filled by a script rather than
    // by the room, so a test database somebody has imported into starts dirty.
    await db.execute(sql`truncate table ${legacyPlays} restart identity cascade`);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${legacyPlays} restart identity cascade`);
  });

  /** Plays a minute apart, oldest first, so the order under test is unambiguous. */
  async function archive(count: number, provider: 'youtube' | 'soundcloud' = 'youtube') {
    await db.insert(legacyPlays).values(
      Array.from({ length: count }, (_, index) => ({
        sourceId: `play-${index}`,
        playedAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
        requesterName: `queup-user-${index % 3}`,
        provider,
        providerMediaId: `video${index.toString().padStart(6, '0')}`,
        title: `Track ${index}`,
        durationSeconds: 200 + index,
        thumbnailUrl: null,
        upvotes: index,
        downvotes: 0,
        skipped: index === 0,
      })),
    );
  }

  it('reads newest first and says how much there is', async () => {
    await archive(5);

    const page = await listLegacyHistory(3, null, db);

    expect(page.total).toBe(5);
    expect(page.entries.map((entry) => entry.title)).toEqual(['Track 4', 'Track 3', 'Track 2']);
    expect(page.entries[0]).toMatchObject({
      requesterName: 'queup-user-1',
      upvotes: 4,
      skipped: false,
      canonicalUrl: 'https://www.youtube.com/watch?v=video000004',
    });
  });

  it('walks the rest by cursor without repeating a row', async () => {
    await archive(5);

    const first = await listLegacyHistory(3, null, db);
    const second = await listLegacyHistory(3, first.nextCursor, db);

    expect(second.entries.map((entry) => entry.title)).toEqual(['Track 1', 'Track 0']);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(5);
  });

  it('leaves a SoundCloud track unlinked, because a numeric id is not a URL', async () => {
    await archive(1, 'soundcloud');

    const [entry] = (await listLegacyHistory(10, null, db)).entries;

    expect(entry).toMatchObject({ provider: 'soundcloud', canonicalUrl: null });
  });

  it('reports an empty archive rather than failing on one', async () => {
    await expect(listLegacyHistory(10, null, db)).resolves.toEqual({
      entries: [],
      total: 0,
      nextCursor: null,
    });
  });
});
