import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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

const { applyArchiveSeed, applyGenreSeed } = await import('./seed');
const schema = await import('./db/schema');
const { legacyPlays, seedState, trackGenres } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('what the room ships with', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  let directory = '';

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
    directory = await mkdtemp(join(tmpdir(), 'dggradio-seed-test-'));
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(
      sql`truncate table ${trackGenres}, ${legacyPlays}, ${seedState} restart identity cascade`,
    );
  });

  function play(sourceId: string, providerMediaId: string) {
    return {
      source_id: sourceId,
      played_at: '2025-01-01T00:00:00.000Z',
      requester_name: 'someone',
      provider: 'youtube' as const,
      provider_media_id: providerMediaId,
      title: 'A track',
      duration_seconds: 210,
      thumbnail_url: null,
      upvotes: 0,
      downvotes: 0,
      skipped: false,
    };
  }

  /** A fresh path each time, so one test's digest cannot answer another's. */
  let counter = 0;
  async function writeArchive(rows: ReturnType<typeof play>[]): Promise<string> {
    const path = join(directory, `archive-${(counter += 1)}.json.gz`);
    await writeFile(path, gzipSync(Buffer.from(JSON.stringify(rows), 'utf8')));
    return path;
  }

  it('applies a file it has not seen', async () => {
    const path = await writeArchive([play('a', 'aaa'), play('b', 'bbb')]);

    expect(await applyArchiveSeed(path, db)).toEqual({ added: 2, kept: 0 });
    expect(await db.$count(legacyPlays)).toBe(2);
  });

  it('does not read the same file into the database twice', async () => {
    const path = await writeArchive([play('a', 'aaa')]);
    await applyArchiveSeed(path, db);

    // Deleting the row and re-applying proves the skip is a real skip: an
    // unchanged file is not read, so the gap it would have filled stays open.
    await db.execute(sql`delete from ${legacyPlays}`);

    expect(await applyArchiveSeed(path, db)).toEqual({ added: 0, kept: 1 });
    expect(await db.$count(legacyPlays)).toBe(0);
  });

  it('applies a regenerated file', async () => {
    await applyArchiveSeed(await writeArchive([play('a', 'aaa')]), db);

    const grown = await writeArchive([play('a', 'aaa'), play('b', 'bbb')]);
    expect(await applyArchiveSeed(grown, db)).toEqual({ added: 1, kept: 1 });
    expect(await db.$count(legacyPlays)).toBe(2);
  });

  it('keeps what the database already holds', async () => {
    const path = await writeArchive([play('a', 'aaa')]);
    await db.insert(legacyPlays).values({
      sourceId: 'a',
      playedAt: new Date('2025-01-01T00:00:00.000Z'),
      requesterName: 'somebody else',
      provider: 'youtube',
      providerMediaId: 'aaa',
      title: 'What the room already called it',
      durationSeconds: 210,
    });

    expect(await applyArchiveSeed(path, db)).toEqual({ added: 0, kept: 1 });
    const [stored] = await db.select().from(legacyPlays);
    expect(stored?.title).toBe('What the room already called it');
  });

  it('records nothing for a file that is not there', async () => {
    expect(await applyArchiveSeed(join(directory, 'absent.json.gz'), db)).toBeNull();
    expect(await db.$count(seedState)).toBe(0);
  });

  it('tracks the two files apart', async () => {
    const archive = await writeArchive([play('a', 'aaa')]);
    const genres = join(directory, 'genres.json');
    await writeFile(
      genres,
      JSON.stringify({
        rows: [
          {
            provider: 'youtube',
            providerMediaId: 'aaa',
            source: 'discogs',
            level: 'master',
            genres: ['Electronic'],
            styles: ['Techno'],
            sourceEntityId: null,
            sourceUrl: null,
            ambiguous: false,
          },
        ],
      }),
      'utf8',
    );

    await applyArchiveSeed(archive, db);
    // The archive being applied must not make the genre file look applied too.
    expect(await applyGenreSeed(genres, db)).toEqual({ added: 1, kept: 0 });
    expect(await db.$count(trackGenres)).toBe(1);
  });
});
