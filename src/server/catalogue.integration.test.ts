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

const { getArtistDetail, getTrackDetail } = await import('./catalogue');
const { storeGenre } = await import('./genre');
const schema = await import('./db/schema');
const { legacyPlays, media, queueItems, trackGenres, users, votes } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('one track, and who published it', () => {
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
      sql`truncate table ${trackGenres}, ${legacyPlays}, ${votes}, ${queueItems}, ${media}, ${users} restart identity cascade`,
    );
  });

  async function createTrack(providerMediaId: string, artistId = 'channel-1') {
    const [row] = await db
      .insert(media)
      .values({
        provider: 'youtube',
        providerMediaId,
        providerArtistId: artistId,
        canonicalUrl: `https://www.youtube.com/watch?v=${providerMediaId}`,
        title: `Track ${providerMediaId}`,
        artist: 'An Artist',
        durationSeconds: 200,
      })
      .returning({ id: media.id });
    return row!.id;
  }

  async function play(mediaId: string, requesterId: string, at: Date) {
    await db.insert(queueItems).values({
      mediaId,
      requestedByUserId: requesterId,
      status: 'played',
      startedAt: at,
      finishedAt: at,
    });
  }

  async function createUser(username: string) {
    const [row] = await db
      .insert(users)
      .values({ dggUserId: `dgg-${username}`, username, dggStatus: 'active' })
      .returning({ id: users.id });
    return row!.id;
  }

  async function archive(sourceId: string, providerMediaId: string, requester: string) {
    await db.insert(legacyPlays).values({
      sourceId,
      playedAt: new Date('2025-06-01T12:00:00.000Z'),
      requesterName: requester,
      provider: 'youtube',
      providerMediaId,
      title: `Archived ${providerMediaId}`,
      durationSeconds: 200,
      upvotes: 3,
      downvotes: 1,
    });
  }

  it('counts a track across both histories and keeps the plays apart', async () => {
    const listener = await createUser('picklesnathan');
    const trackId = await createTrack('aaaaaaaaaaa');
    await play(trackId, listener, new Date('2026-08-01T12:00:00.000Z'));
    await archive('play-1', 'aaaaaaaaaaa', 'a queup name');
    await archive('play-2', 'aaaaaaaaaaa', 'another queup name');

    const track = await getTrackDetail('youtube', 'aaaaaaaaaaa', db);

    expect(track.totals).toMatchObject({ roomPlays: 1, archivePlays: 2, upvotes: 6, downvotes: 2 });
    expect(track.roomPlays).toHaveLength(1);
    expect(track.roomPlays[0]?.requester?.username).toBe('picklesnathan');
    expect(track.archivePlays).toHaveLength(2);
    // An archived play is a name and nothing more: there is no account behind it.
    expect(track.archivePlays[0]?.requester).toBeNull();
    expect(track.archivePlays[0]?.requesterName).toBe('a queup name');
  });

  it('has a page for a track only the archive remembers', async () => {
    await archive('play-1', 'bbbbbbbbbbb', 'a queup name');

    const track = await getTrackDetail('youtube', 'bbbbbbbbbbb', db);

    expect(track.mediaId).toBeNull();
    // QueUp never stored who made a track, so there is nobody to attribute it to.
    expect(track.artist).toBeNull();
    expect(track.providerArtistId).toBeNull();
    expect(track.title).toBe('Archived bbbbbbbbbbb');
    expect(track.totals.archivePlays).toBe(1);
    expect(track.related.byArtist).toEqual([]);
  });

  it('refuses a track neither history has ever seen', async () => {
    await expect(getTrackDetail('youtube', 'ccccccccccc', db)).rejects.toMatchObject({
      code: 'TRACK_NOT_FOUND',
    });
  });

  it('offers other tracks sharing a genre, from either history', async () => {
    await createTrack('aaaaaaaaaaa');
    await archive('play-1', 'bbbbbbbbbbb', 'a queup name');
    for (const id of ['aaaaaaaaaaa', 'bbbbbbbbbbb']) {
      await storeGenre(
        {
          provider: 'youtube',
          providerMediaId: id,
          source: 'discogs',
          level: 'master',
          genres: ['Rock'],
          styles: [],
          sourceEntityId: null,
          sourceUrl: null,
          ambiguous: false,
        },
        db,
      );
    }

    const track = await getTrackDetail('youtube', 'aaaaaaaaaaa', db);

    expect(track.related.byGenre.map((other) => other.providerMediaId)).toEqual(['bbbbbbbbbbb']);
  });

  it('gathers an artist tracks, counting both histories against each', async () => {
    const listener = await createUser('picklesnathan');
    const quiet = await createTrack('aaaaaaaaaaa');
    const busy = await createTrack('bbbbbbbbbbb');
    await play(busy, listener, new Date('2026-08-01T12:00:00.000Z'));
    await play(busy, listener, new Date('2026-08-02T12:00:00.000Z'));
    await archive('play-1', 'aaaaaaaaaaa', 'a queup name');

    const artist = await getArtistDetail('youtube', 'channel-1', db);

    expect(artist.name).toBe('An Artist');
    expect(artist.totals).toEqual({ tracks: 2, roomPlays: 2, archivePlays: 1 });
    // Most played first, across both.
    expect(artist.tracks.map((track) => track.providerMediaId)).toEqual([
      'bbbbbbbbbbb',
      'aaaaaaaaaaa',
    ]);
    expect(artist.tracks[0]).toMatchObject({ roomPlays: 2, archivePlays: 0 });
    expect(artist.tracks[1]).toMatchObject({ roomPlays: 0, archivePlays: 1 });
    expect(quiet).toBeDefined();
  });

  it('refuses an artist the room has no tracks by', async () => {
    await expect(getArtistDetail('youtube', 'channel-nobody', db)).rejects.toMatchObject({
      code: 'ARTIST_NOT_FOUND',
    });
  });
});
