/**
 * PROTOTYPE: how often MusicBrainz itself links a YouTube video to a recording.
 *
 * This is the question that decides whether a MusicBrainz dump can be joined
 * the way the Discogs one is. Discogs won because it embeds 5.76 million
 * YouTube video ids in its masters, which makes the join exact and needs no
 * identity guessing at all. If MusicBrainz carries comparable `url` relations
 * to recordings, the same trick works and the YouTube Music card stops being
 * needed. If it does not, a dump can still remove the per-track requests but
 * identity has to keep coming from the card.
 *
 * Asked through the API against a sample rather than by downloading several
 * gigabytes to find out: `/ws/2/url?resource=...` answers exactly this, one
 * track at a time, and a hundred tracks settles the order of magnitude.
 *
 *   npx tsx scripts/musicbrainz-youtube-relations.prototype.ts [sample-size]
 *
 * One request a second is the published limit. This spaces them wider, sends a
 * real User-Agent, and caches every answer in the OS temporary directory by
 * complete URL, so a rerun costs nothing.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/server/db/schema';

const USER_AGENT = 'DggRadio/0.1.0 (https://github.com/NickMarcha/dgg-radio)';
const REQUEST_SPACING_MS = 1_200;
const cacheDirectory = join(tmpdir(), 'dggradio-musicbrainz-url-relations');
const outputFile = join(tmpdir(), 'dggradio-musicbrainz-youtube-relations.json');

interface Relation {
  'target-type'?: string;
  type?: string;
  recording?: { id?: string; title?: string };
  release?: { id?: string; title?: string };
  artist?: { id?: string; name?: string };
}

interface UrlLookup {
  id?: string;
  relations?: Relation[];
}

let lastRequestAt = 0;
let networkRequests = 0;
let cachedRequests = 0;

async function cachedJson<T>(endpoint: URL): Promise<T | null> {
  const key = createHash('sha256').update(`${endpoint}\n${USER_AGENT}`).digest('hex');
  const cacheFile = join(cacheDirectory, `${key}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { status: number; body: T };
    cachedRequests += 1;
    return cached.status === 404 ? null : cached.body;
  } catch {
    // Fall through and ask.
  }

  // 503 is how MusicBrainz says slow down, and it says it even inside the
  // published limit when it is busy. Backing off and retrying is the whole
  // difference between a sample that finishes and one that dies on track four.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    networkRequests += 1;

    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });

    // A url MusicBrainz has never been told about is a 404, and that is an
    // answer worth caching rather than an error.
    if (response.status === 404) {
      await writeFile(cacheFile, JSON.stringify({ status: 404, body: null }), 'utf8');
      return null;
    }
    if (response.ok) {
      const body = (await response.json()) as T;
      await writeFile(cacheFile, JSON.stringify({ status: 200, body }), 'utf8');
      return body;
    }
    if (response.status !== 429 && response.status !== 503) {
      throw new Error(`MusicBrainz answered ${response.status}`);
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(retryAfter * 1_000, 2_000)
        : 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`MusicBrainz kept refusing ${endpoint.searchParams.get('resource')}`);
}

/** Both spellings of a YouTube link, because either may be the one stored. */
function candidates(videoId: string): URL[] {
  return [`https://www.youtube.com/watch?v=${videoId}`, `https://youtu.be/${videoId}`].map(
    (resource) => {
      const endpoint = new URL('https://musicbrainz.org/ws/2/url');
      endpoint.searchParams.set('resource', resource);
      endpoint.searchParams.set('inc', 'recording-rels+release-rels+artist-rels');
      endpoint.searchParams.set('fmt', 'json');
      return endpoint;
    },
  );
}

async function main(): Promise<void> {
  const sampleSize = Number(process.argv[2] ?? 100);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Set it in the environment or in .env.');
    process.exit(1);
  }
  await mkdir(cacheDirectory, { recursive: true });

  const db = drizzle({ connection: url, schema });
  // The most played tracks, because those are the ones any enrichment would
  // reach first and the ones worth being right about.
  const wanted = await db.execute<{ provider_media_id: string; title: string; plays: number }>(sql`
    select provider_media_id, min(title) as title, count(*)::int as plays
    from legacy_plays
    where provider = 'youtube'
    group by provider_media_id
    order by count(*) desc, provider_media_id
    limit ${sampleSize}
  `);

  console.log(`Asking MusicBrainz about ${wanted.rows.length} of the room's most played tracks`);

  const rows = [];
  let linked = 0;
  let toRecording = 0;
  let toRelease = 0;
  let toArtist = 0;

  for (const [index, track] of wanted.rows.entries()) {
    if ((index + 1) % 20 === 0) console.log(`  ${index + 1}/${wanted.rows.length}`);

    let found: UrlLookup | null = null;
    for (const endpoint of candidates(track.provider_media_id)) {
      found = await cachedJson<UrlLookup>(endpoint);
      if (found) break;
    }

    const relations = found?.relations ?? [];
    const recordings = relations.filter((relation) => relation.recording?.id).length;
    const releases = relations.filter((relation) => relation.release?.id).length;
    const artists = relations.filter((relation) => relation.artist?.id).length;
    if (relations.length > 0) linked += 1;
    if (recordings > 0) toRecording += 1;
    if (releases > 0) toRelease += 1;
    if (artists > 0) toArtist += 1;

    rows.push({
      youtubeId: track.provider_media_id,
      title: track.title,
      plays: track.plays,
      known: found !== null,
      recordings,
      releases,
      artists,
    });
  }

  const percent = (value: number) =>
    Number(((value / Math.max(rows.length, 1)) * 100).toFixed(1));

  const summary = {
    generatedAt: new Date().toISOString(),
    sampled: rows.length,
    urlKnownToMusicBrainz: { count: rows.filter((row) => row.known).length, percent: percent(rows.filter((row) => row.known).length) },
    anyRelation: { count: linked, percent: percent(linked) },
    toRecording: { count: toRecording, percent: percent(toRecording) },
    toRelease: { count: toRelease, percent: percent(toRelease) },
    toArtist: { count: toArtist, percent: percent(toArtist) },
    requests: { networkRequests, cachedRequests },
  };

  await writeFile(outputFile, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log(`\nWrote ${outputFile}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

await main();
