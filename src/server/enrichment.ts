import type { MediaProvider } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { searchGenre } from './discogs';
import { guessTrackIdentity, listGenres, storeGenre, trackKey } from './genre';
import { findGenres, findRecording } from './musicbrainz';
import { findMusicCard } from './youtube-music';

/**
 * Working out what a track is, the first time the room sees one.
 *
 * The archive was labelled in bulk from data dumps, which is the only sensible
 * way to do 34,000 tracks. A track somebody queues today is one track, and one
 * track can simply be asked about — so it is, once, in the background, and the
 * answer is stored beside the ones the dumps produced.
 *
 * Everything here is deliberately slow and out of the way. Both services are
 * rate limited, their clients queue requests behind one another, and nothing a
 * listener does waits on any of it: a request is accepted, the room plays, and
 * the genre appears on the next poll or the one after.
 *
 * Identity comes from the video's own YouTube Music card where there is one,
 * because `Fatboy Slim - Right Here, Right Now [Official 4K Video]` is not a
 * title any catalogue holds and the channel is not who the track is credited
 * to. Where there is no card, the upload title is split on its dash instead,
 * which is worse and still usually right.
 */

/** Tracks currently being asked about, so two requests do not both ask. */
const inFlight = new Set<string>();

/** How many may be waiting before new ones are dropped rather than queued. */
const MAX_WAITING = 200;
let waiting = 0;

interface Identity {
  artist: string;
  title: string;
}

/**
 * What to look the track up as. The Music card is the good answer and the
 * upload title is the fallback, so a video YouTube has no card for still gets
 * a try rather than nothing.
 */
async function identify(
  providerMediaId: string,
  uploadTitle: string,
  channel: string,
  provider: MediaProvider,
): Promise<Identity | null> {
  if (provider === 'youtube') {
    try {
      const card = await findMusicCard(providerMediaId);
      if (card) return { artist: card.artist, title: card.title };
    } catch {
      // YouTube's watch page is a private response that changes shape without
      // warning. Losing it costs precision, not the lookup.
    }
  }
  const guessed = guessTrackIdentity(uploadTitle, channel);
  return guessed.artist && guessed.title ? guessed : null;
}

async function askMusicBrainz(
  track: { provider: MediaProvider; providerMediaId: string },
  identity: Identity,
  db: Database,
): Promise<void> {
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

  const recording = await findRecording(identity.title, identity.artist);
  if (!recording) {
    await storeGenre(nothing, db);
    return;
  }
  const found = await findGenres(recording.mbid);
  if (!found) {
    await storeGenre({ ...nothing, sourceEntityId: recording.mbid }, db);
    return;
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
}

async function askDiscogs(
  track: { provider: MediaProvider; providerMediaId: string },
  identity: Identity,
  db: Database,
): Promise<void> {
  const found = await searchGenre(identity.artist, identity.title);
  await storeGenre(
    {
      ...track,
      source: 'discogs',
      level: found ? 'master' : null,
      genres: found?.genres ?? [],
      styles: found?.styles ?? [],
      sourceEntityId: null,
      sourceUrl: found?.url ?? null,
      // A search answers about one release, so nothing disagrees with it.
      ambiguous: false,
    },
    db,
  );
}

/**
 * Asks both services about one track and stores what they say, skipping
 * whichever has already answered for it. Never throws: this is called and
 * forgotten from the request path, so a failure has nowhere to go but a log.
 */
async function enrich(
  provider: MediaProvider,
  providerMediaId: string,
  uploadTitle: string,
  channel: string,
  db: Database,
): Promise<void> {
  const track = { provider, providerMediaId };
  const stored = await listGenres([track], db);
  const answered = new Set(
    stored.get(trackKey(provider, providerMediaId))?.entries.map((entry) => entry.source) ?? [],
  );
  if (answered.has('musicbrainz') && answered.has('discogs')) return;

  const identity = await identify(providerMediaId, uploadTitle, channel, provider);
  if (!identity) return;

  if (!answered.has('musicbrainz')) await askMusicBrainz(track, identity, db);
  if (!answered.has('discogs')) await askDiscogs(track, identity, db);
}

/**
 * Queues a track to be looked up, and returns immediately.
 *
 * The queue is in memory and bounded. A restart loses whatever was waiting,
 * and a burst past the limit drops the overflow — in both cases the track is
 * still in the room and the next dump import picks it up, so the cost of
 * losing one is that its genre arrives later rather than never.
 */
export function enrichTrack(
  provider: MediaProvider,
  providerMediaId: string,
  uploadTitle: string,
  channel: string,
  db: Database = getDatabase(),
): void {
  const key = trackKey(provider, providerMediaId);
  if (inFlight.has(key) || waiting >= MAX_WAITING) return;

  inFlight.add(key);
  waiting += 1;
  void enrich(provider, providerMediaId, uploadTitle, channel, db)
    .catch((error) => {
      console.error(`Could not work out what ${key} is`, error);
    })
    .finally(() => {
      inFlight.delete(key);
      waiting -= 1;
    });
}
