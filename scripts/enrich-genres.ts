/**
 * Labels the room's tracks with genre from MusicBrainz.
 *
 *   npx tsx scripts/enrich-genres.ts                 # 200 tracks, most played first
 *   npx tsx scripts/enrich-genres.ts --limit 2000
 *   npx tsx scripts/enrich-genres.ts --recheck 30    # also re-ask about older misses
 *
 * Three requests a track at the far end of a one-a-second limit, so this is
 * slow by design and safe to stop: every answer is written as it arrives, and
 * the next run starts from where this one got to. Tracks are taken most played
 * first, so an hour of it labels the music people actually hear rather than an
 * arbitrary hour of the long tail.
 *
 * The route for each track is: the video's own YouTube Music card gives a
 * catalogue title and artist, MusicBrainz is searched for the recording those
 * name, and its genre is read from the recording, or the release group it
 * appeared on, or -- coarsely, and labelled as such -- its artist.
 *
 * A track nobody has an answer for gets an empty row, so the next run does not
 * spend three more requests learning the same nothing. `--recheck <days>` is
 * what re-opens those, for a catalogue that has grown since.
 *
 * The other half of the genre picture is `discogs-dump-import.ts`, which needs
 * no requests at all. Run that first: it is faster, it covers a third of the
 * archive, and this is then filling the gaps rather than duplicating it.
 *
 * Only DATABASE_URL is needed, from the environment or `.env`.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/server/db/schema';
import { listUnlabelledTracks, storeGenre, type TrackKey } from '../src/server/genre';
import { findGenres, findRecording } from '../src/server/musicbrainz';
import { findMusicCard } from '../src/server/youtube-music';

type Database = ReturnType<typeof openDatabase>;

function openDatabase(url: string) {
  return drizzle({ connection: url, schema });
}

interface Tally {
  labelled: number;
  /** Answered at track level rather than from the artist's whole catalogue. */
  aboutTheTrack: number;
  noCard: number;
  noRecording: number;
  noGenre: number;
  failed: number;
}

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

/**
 * One track, end to end. Anything the sources genuinely did not know is written
 * as an empty row; anything that went wrong on the way -- a timeout, a refused
 * request, YouTube changing its page -- is not, so it is tried again next run
 * rather than remembered as an absence.
 */
async function enrich(track: TrackKey, db: Database, tally: Tally): Promise<string> {
  const nothing = {
    ...track,
    source: 'musicbrainz' as const,
    level: null,
    genres: [],
    styles: [],
    sourceEntityId: null,
    sourceUrl: null,
    ambiguous: false,
  };

  const card = await findMusicCard(track.providerMediaId);
  if (!card) {
    tally.noCard += 1;
    await storeGenre(nothing, db);
    return 'no music card';
  }

  const recording = await findRecording(card.title, card.artist);
  if (!recording) {
    tally.noRecording += 1;
    await storeGenre(nothing, db);
    return `no recording for ${card.artist} - ${card.title}`;
  }

  const found = await findGenres(recording.mbid);
  if (!found) {
    tally.noGenre += 1;
    await storeGenre({ ...nothing, sourceEntityId: recording.mbid }, db);
    return `no genre for ${card.artist} - ${card.title}`;
  }

  await storeGenre(
    {
      ...track,
      source: 'musicbrainz',
      level: found.level,
      genres: found.genres,
      styles: [],
      sourceEntityId: found.entityId,
      sourceUrl: found.url,
      ambiguous: false,
    },
    db,
  );
  tally.labelled += 1;
  if (found.level !== 'artist') tally.aboutTheTrack += 1;
  return `${found.level}: ${found.genres.join(', ')}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }

  const limit = Number(flag('limit') ?? 200);
  const recheckDays = flag('recheck') === null ? null : Number(flag('recheck'));
  if (!Number.isInteger(limit) || limit < 1) {
    console.error('--limit must be a positive whole number.');
    process.exit(1);
  }
  if (recheckDays !== null && (!Number.isFinite(recheckDays) || recheckDays < 0)) {
    console.error('--recheck must be a number of days.');
    process.exit(1);
  }

  const db = openDatabase(url);
  const recheckBefore =
    recheckDays === null ? null : new Date(Date.now() - recheckDays * 24 * 60 * 60 * 1_000);
  const tracks = await listUnlabelledTracks('musicbrainz', limit, recheckBefore, db);
  if (tracks.length === 0) {
    console.log('Every known YouTube track has a MusicBrainz answer already.');
    process.exit(0);
  }

  console.log(`Asking MusicBrainz about ${tracks.length} tracks, most played first`);
  const tally: Tally = {
    labelled: 0,
    aboutTheTrack: 0,
    noCard: 0,
    noRecording: 0,
    noGenre: 0,
    failed: 0,
  };

  for (const [index, track] of tracks.entries()) {
    const position = `${index + 1}/${tracks.length}`;
    try {
      const outcome = await enrich(track, db, tally);
      console.log(`  ${position} ${track.providerMediaId} ${outcome}`);
    } catch (error) {
      tally.failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  ${position} ${track.providerMediaId} failed: ${reason}`);
    }
  }

  console.log(
    `\nLabelled ${tally.labelled} of ${tracks.length}, ` +
      `${tally.aboutTheTrack} of them about the track rather than the artist.\n` +
      `Nothing found: ${tally.noCard} with no Music card, ` +
      `${tally.noRecording} with no matching recording, ${tally.noGenre} with no genre. ` +
      `${tally.failed} to try again next run.`,
  );
  process.exit(0);
}

await main();
