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

const {
  getGenreStats,
  guessTrackIdentity,
  listGenres,
  listUnlabelledTracks,
  storeGenre,
  trackKey,
} = await import('./genre');
const { listLegacyHistory } = await import('./legacy');
const schema = await import('./db/schema');
const { legacyPlays, media, trackGenres } = schema;
const connectionString = testConnectionString();

describe.skipIf(!connectionString)('what a track is', () => {
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
      sql`truncate table ${trackGenres}, ${legacyPlays}, ${media} restart identity cascade`,
    );
  });

  const youtube = (providerMediaId: string) => ({ provider: 'youtube' as const, providerMediaId });

  async function label(
    providerMediaId: string,
    row: Partial<Parameters<typeof storeGenre>[0]> & { source: 'musicbrainz' | 'discogs' },
  ) {
    await storeGenre(
      {
        ...youtube(providerMediaId),
        level: 'recording',
        genres: ['post-rock'],
        styles: [],
        sourceEntityId: null,
        sourceUrl: null,
        ambiguous: false,
        ...row,
      },
      db,
    );
  }

  it('keeps each source in its own words and says when a second one agreed', async () => {
    await label('video000001', { source: 'musicbrainz', genres: ['indie rock', 'post-punk'] });
    await label('video000001', {
      source: 'discogs',
      level: 'master',
      genres: ['Rock'],
      styles: ['Indie Rock'],
    });

    const found = (await listGenres([youtube('video000001')], db)).get(
      trackKey('youtube', 'video000001'),
    );

    expect(found?.corroborated).toBe(true);
    expect(found?.artistLevelOnly).toBe(false);
    // Neither vocabulary is rewritten into the other.
    expect(found?.entries.map((entry) => [entry.source, entry.genres])).toEqual([
      ['discogs', ['Rock']],
      ['musicbrainz', ['indie rock', 'post-punk']],
    ]);
  });

  it('does not call one source agreeing with itself corroboration', async () => {
    await label('video000001', { source: 'discogs', level: 'master', genres: ['Rock'] });

    const found = (await listGenres([youtube('video000001')], db)).get(
      trackKey('youtube', 'video000001'),
    );

    expect(found?.corroborated).toBe(false);
  });

  it('marks a track nobody can describe more closely than its artist', async () => {
    await label('video000001', {
      source: 'musicbrainz',
      level: 'artist',
      genres: ['ambient', 'downtempo'],
    });

    const found = (await listGenres([youtube('video000001')], db)).get(
      trackKey('youtube', 'video000001'),
    );

    expect(found?.artistLevelOnly).toBe(true);
  });

  it('treats a stored absence as nothing to show', async () => {
    await label('video000001', { source: 'musicbrainz', level: null, genres: [] });

    await expect(listGenres([youtube('video000001')], db)).resolves.toEqual(new Map());
  });

  it('writes a newer answer over an older one rather than keeping both', async () => {
    await label('video000001', { source: 'musicbrainz', level: null, genres: [] });
    await label('video000001', { source: 'musicbrainz', genres: ['shoegaze'] });

    const found = (await listGenres([youtube('video000001')], db)).get(
      trackKey('youtube', 'video000001'),
    );

    expect(found?.entries).toHaveLength(1);
    expect(found?.entries[0]?.genres).toEqual(['shoegaze']);
  });

  it('offers the most played unlabelled tracks first, and skips labelled ones', async () => {
    await db.insert(legacyPlays).values(
      // `once` played once, `often` three times, `done` twice but already labelled.
      [
        ['play-1', 'once'],
        ['play-2', 'often'],
        ['play-3', 'often'],
        ['play-4', 'often'],
        ['play-5', 'done'],
        ['play-6', 'done'],
      ].map(([sourceId, videoId], index) => ({
        sourceId: sourceId!,
        playedAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
        requesterName: 'someone',
        provider: 'youtube' as const,
        providerMediaId: videoId!,
        title: `Track ${videoId}`,
        durationSeconds: 200,
      })),
    );
    await label('done', { source: 'musicbrainz', genres: ['dub'] });

    const unlabelled = await listUnlabelledTracks('musicbrainz', 10, null, db);

    expect(unlabelled.map((track) => track.providerMediaId)).toEqual(['often', 'once']);
  });

  it('re-asks about a recorded absence only once it is old enough', async () => {
    await db.insert(legacyPlays).values({
      sourceId: 'play-1',
      playedAt: new Date('2025-01-01T00:00:00.000Z'),
      requesterName: 'someone',
      provider: 'youtube',
      providerMediaId: 'video000001',
      title: 'A Track',
      durationSeconds: 200,
    });
    await label('video000001', { source: 'musicbrainz', level: null, genres: [] });

    const fresh = await listUnlabelledTracks('musicbrainz', 10, null, db);
    const stale = await listUnlabelledTracks('musicbrainz', 10, new Date(Date.now() + 1_000), db);

    expect(fresh).toEqual([]);
    expect(stale.map((track) => track.providerMediaId)).toEqual(['video000001']);
  });

  /** Two archived plays of one track and one of another, so counts differ. */
  async function archive(entries: [sourceId: string, videoId: string][]) {
    await db.insert(legacyPlays).values(
      entries.map(([sourceId, videoId], index) => ({
        sourceId,
        playedAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
        requesterName: 'someone',
        provider: 'youtube' as const,
        providerMediaId: videoId,
        title: `Track ${videoId}`,
        durationSeconds: 200,
      })),
    );
  }

  it('narrows a history to one genre, and counts a style as one', async () => {
    await archive([
      ['play-1', 'rocktrack'],
      ['play-2', 'housetrack'],
    ]);
    await label('rocktrack', {
      source: 'discogs',
      level: 'master',
      genres: ['Rock'],
      styles: ['Indie Rock'],
    });
    await label('housetrack', { source: 'discogs', level: 'master', genres: ['Electronic'] });

    const byGenre = await listLegacyHistory({ genre: 'Rock' }, db);
    // `Indie Rock` is a Discogs style rather than a genre, and a reader clicking
    // the tag should not have to know the difference.
    const byStyle = await listLegacyHistory({ genre: 'indie rock' }, db);
    const byNeither = await listLegacyHistory({ genre: 'Jazz' }, db);

    expect(byGenre.entries.map((entry) => entry.title)).toEqual(['Track rocktrack']);
    expect(byStyle.entries.map((entry) => entry.title)).toEqual(['Track rocktrack']);
    expect(byNeither).toEqual({ entries: [], total: 0 });
  });

  it('counts plays by genre, keeping the two histories apart', async () => {
    await archive([
      ['play-1', 'rocktrack'],
      ['play-2', 'rocktrack'],
      ['play-3', 'housetrack'],
    ]);
    await label('rocktrack', { source: 'discogs', level: 'master', genres: ['Rock'] });
    await label('housetrack', { source: 'discogs', level: 'master', genres: ['Electronic'] });
    // Artist-level genre describes a catalogue, so it is not what the room plays.
    await label('housetrack', { source: 'musicbrainz', level: 'artist', genres: ['ambient'] });

    const stats = await getGenreStats(db);

    expect(stats.genres).toEqual([
      { genre: 'Rock', roomPlays: 0, archivePlays: 2, sources: ['discogs'] },
      { genre: 'Electronic', roomPlays: 0, archivePlays: 1, sources: ['discogs'] },
    ]);
    expect(stats.coverage).toEqual({ labelledTracks: 2, tracks: 2 });
  });

  it('counts a track once for one genre, however many sources spell it', async () => {
    await archive([['play-1', 'rocktrack']]);
    await label('rocktrack', { source: 'discogs', level: 'master', genres: ['Rock'] });
    await label('rocktrack', { source: 'musicbrainz', genres: ['rock'] });

    const stats = await getGenreStats(db);

    // One play, one genre, whichever way the two sources capitalise it -- and
    // both of them are named, because the chart merges the count and not the
    // vocabularies.
    expect(stats.genres).toEqual([
      { genre: 'Rock', roomPlays: 0, archivePlays: 1, sources: ['discogs', 'musicbrainz'] },
    ]);
  });

  it('labels a track the room has never played, because the archive is most of them', async () => {
    await db.insert(media).values({
      provider: 'youtube',
      providerMediaId: 'video000001',
      providerArtistId: 'channel-1',
      canonicalUrl: 'https://www.youtube.com/watch?v=video000001',
      title: 'A Track',
      artist: 'An Artist',
      durationSeconds: 200,
    });

    const unlabelled = await listUnlabelledTracks('discogs', 10, null, db);

    expect(unlabelled).toEqual([{ provider: 'youtube', providerMediaId: 'video000001' }]);
  });
});

describe('reading an artist and a title off an upload', () => {
  it('splits the usual "Artist - Title" and drops what a catalogue does not carry', () => {
    expect(
      guessTrackIdentity('Fatboy Slim - Right Here, Right Now (Official Video)', 'Fatboy Slim'),
    ).toEqual({ artist: 'Fatboy Slim', title: 'Right Here, Right Now' });
  });

  it('falls back to the channel, without YouTube own Topic suffix', () => {
    expect(guessTrackIdentity('Everything In Its Right Place', 'Radiohead - Topic')).toEqual({
      artist: 'Radiohead',
      title: 'Everything In Its Right Place',
    });
  });
});
