import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './auth';
import type { MediaMetadata } from './media';
import type { UserRole } from '../shared/contracts';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { cachedLookup, playbackIssues } = vi.hoisted(() => ({
  cachedLookup: vi.fn(),
  /** URLs the station cannot play. Their metadata still resolves, as it does live. */
  playbackIssues: new Map<string, Error>(),
}));

vi.mock('./media-cache', () => {
  const inspect = async (url: string, country: string, db: unknown) => ({
    metadata: await cachedLookup(url, country, db),
    playbackIssue: playbackIssues.get(url) ?? null,
  });
  // The real batch resolves in parallel and keeps failures; this mirrors that
  // over whatever the single-lookup stub is doing.
  const many = async <T,>(urls: string[], resolve: (url: string) => Promise<T>) => {
    const resolved = new Map<string, T | Error>();
    for (const url of urls) {
      try {
        resolved.set(url, await resolve(url));
      } catch (error) {
        resolved.set(url, error as Error);
      }
    }
    return resolved;
  };
  const lookup = async (url: string, country: string, db: unknown) => {
    const inspected = await inspect(url, country, db);
    if (inspected.playbackIssue) throw inspected.playbackIssue;
    return inspected.metadata;
  };
  return {
    inspectMediaCached: vi.fn(inspect),
    inspectManyCached: vi.fn((urls: string[], country: string, db: unknown) =>
      many(urls, (url) => inspect(url, country, db)),
    ),
    lookupMediaCached: vi.fn(lookup),
    lookupManyCached: vi.fn((urls: string[], country: string, db: unknown) =>
      many(urls, (url) => lookup(url, country, db)),
    ),
    // Only a cost saving live: the per-track lookups below answer the same
    // either way, so the stub does nothing.
    warmYouTubeLookups: vi.fn(async () => {}),
  };
});

vi.mock('./media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media')>()),
  listPlaylistTrackUrls: vi.fn(),
}));

const { listPlaylistTrackUrls, MediaLookupError } = await import('./media');
const {
  advanceCurrentTrack,
  advanceIfExpired,
  clearUserQueue,
  dismissQueueNotice,
  enqueueProviderPlaylist,
  reorderMyQueue,
  reorderStationQueue,
  blockMediaByUrl,
  blockQueueItemMedia,
  enqueueMedia,
  ensureStationExists,
  getStationSnapshot,
  moveQueue,
  planQueueMove,
  StationError,
  skipCurrentTrack,
  voteOnCurrentTrack,
  withdrawQueuedTrack,
} = await import('./station');
const {
  canEditRule,
  copyRule,
  createRule,
  findBlockingRules,
  followRule,
  grantRuleEditor,
  listActiveRules,
  listRuleChanges,
  listRuleEntries,
  removeRuleEntry,
  revertRuleChange,
} = await import('./rules');
const schema = await import('./db/schema');
const { MAIN_STATION_ID } = await import('./stations');
const { media, moderationActions, queueItems, stationSettings, stationState, users } = schema;

const connectionString = testConnectionString();

function track(id: string, durationSeconds = 120): MediaMetadata {
  return {
    provider: 'youtube',
    providerMediaId: id,
    providerArtistId: `channel-${id}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: `Track ${id}`,
    artist: 'Test Artist',
    durationSeconds,
    thumbnailUrl: null,
  };
}

describe.skipIf(!connectionString)('station transitions against Postgres', () => {
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
      sql`truncate table ${moderationActions}, ${schema.votes}, ${schema.ruleEntries}, ${schema.rules}, ${stationState}, ${schema.stationSettings}, ${queueItems}, ${media}, ${schema.sessions}, ${schema.userChatCounts}, ${users} restart identity cascade`,
    );
    await db.delete(schema.stations).where(sql`${schema.stations.id} <> ${MAIN_STATION_ID}`);
    cachedLookup.mockReset();
    playbackIssues.clear();
  });

  /** A station besides the main one, with its settings and state in place. */
  async function createStation(slug: string): Promise<string> {
    const [station] = await db
      .insert(schema.stations)
      .values({ slug, name: slug })
      .returning({ id: schema.stations.id });
    if (!station) throw new Error('Could not create the test station');
    await ensureStationExists(station.id, db);
    return station.id;
  }

  /** `mod` makes them one of the main station's moderators, which is a station role. */
  async function createUser(
    username: string,
    role: UserRole | 'mod' = 'listener',
  ): Promise<AuthenticatedUser> {
    const [row] = await db
      .insert(users)
      .values({
        dggUserId: `dgg-${username}`,
        username,
        role: role === 'mod' ? 'listener' : role,
        dggStatus: 'active',
      })
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        avatarUrl: users.avatarUrl,
        team: users.team,
        flair: users.flair,
        topEmote: users.topEmote,
        dggUserId: users.dggUserId,
        dggRoles: users.dggRoles,
        dggFeatures: users.dggFeatures,
      });
    if (!row) throw new Error('Could not create the test user');
    if (role === 'mod') {
      await db
        .insert(schema.stationMembers)
        .values({ stationId: MAIN_STATION_ID, userId: row.id, role: 'mod' });
    }
    return row;
  }

  function resolveTracks(...tracks: MediaMetadata[]): void {
    const byUrl = new Map(tracks.map((entry) => [entry.canonicalUrl, entry]));
    cachedLookup.mockImplementation(async (url: string) => {
      const found = byUrl.get(url);
      if (!found) throw new Error(`No stubbed metadata for ${url}`);
      return found;
    });
  }

  it('exposes a 90-minute track repeat cooldown by default', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);

    expect(snapshot.settings.repeatCooldownSeconds).toBe(5_400);
  });

  it('starts the first request immediately and queues the rest', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const first = track('aaaaaaaaaaa');
    const second = track('bbbbbbbbbbb');
    resolveTracks(first, second);

    const started = await enqueueMedia(MAIN_STATION_ID, first.canonicalUrl, nathan, db);
    const queued = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db);
    expect(snapshot.current?.id).toBe(started.id);
    expect(snapshot.current?.media.providerMediaId).toBe('aaaaaaaaaaa');
    expect(snapshot.queue.map((item) => item.id)).toEqual([queued.id]);
  });

  it('gives a waiting requester the next turn before a second request from the same user', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [playing, nathanSecond, swagyFirst] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, nathanSecond, swagyFirst);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const nathanQueued = await enqueueMedia(MAIN_STATION_ID, nathanSecond.canonicalUrl, nathan, db);
    const swagyQueued = await enqueueMedia(MAIN_STATION_ID, swagyFirst.canonicalUrl, swagy, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(snapshot.queue.map((item) => item.id)).toEqual([swagyQueued.id, nathanQueued.id]);
  });

  it('counts votes on the playing track and clears them on a zero vote', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await voteOnCurrentTrack(started.id, 1, swagy, 10, db);
    await voteOnCurrentTrack(started.id, -1, admin, 10, db);

    const withBothVotes = await getStationSnapshot(MAIN_STATION_ID, swagy, 2, db);
    expect(withBothVotes.current).toMatchObject({ upvotes: 1, downvotes: 1, myVote: 1 });

    await voteOnCurrentTrack(started.id, 0, swagy, 10, db);
    const afterClearing = await getStationSnapshot(MAIN_STATION_ID, swagy, 2, db);
    expect(afterClearing.current).toMatchObject({ upvotes: 0, downvotes: 1, myVote: 0 });
  });

  it('rejects a vote once the track is no longer playing', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await skipCurrentTrack(MAIN_STATION_ID, 'Meme song', admin, db);

    await expect(voteOnCurrentTrack(started.id, 1, admin, 10, db)).rejects.toThrow(StationError);
  });

  it('skips the current track, records the action, and starts the next one', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const moderator = await createUser('mod', 'mod');
    const playing = track('aaaaaaaaaaa');
    const next = track('bbbbbbbbbbb');
    resolveTracks(playing, next);

    const skipped = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(MAIN_STATION_ID, next.canonicalUrl, nathan, db);
    await skipCurrentTrack(MAIN_STATION_ID, 'Rule 1: no memes', moderator, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(snapshot.current?.id).toBe(promoted.id);
    expect(snapshot.queue).toEqual([]);

    const [skippedRow] = await db
      .select({ status: queueItems.status, reason: queueItems.moderationReason })
      .from(queueItems)
      .where(eq(queueItems.id, skipped.id));
    expect(skippedRow).toMatchObject({ status: 'skipped', reason: 'Rule 1: no memes' });

    const actions = await db.select({ action: moderationActions.action }).from(moderationActions);
    expect(actions.map(({ action }) => action)).toEqual(['skip']);
  });

  it('blocks a track so it drops out of the queue and cannot be requested again', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('admin', 'admin');
    const moderator = await createUser('mod', 'mod');
    const playing = track('aaaaaaaaaaa');
    const banned = track('bbbbbbbbbbb');
    resolveTracks(playing, banned);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const queued = await enqueueMedia(MAIN_STATION_ID, banned.canonicalUrl, swagy, db);
    const ruleId = await createRule(
      MAIN_STATION_ID,
      { name: 'No meme songs', description: '', enforcement: 'blocklist' },
      admin,
      db,
    );
    await blockQueueItemMedia(queued.id, { ruleIds: [ruleId], entryType: 'track' }, moderator, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(snapshot.queue).toEqual([]);
    await expect(enqueueMedia(MAIN_STATION_ID, banned.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'MEDIA_BLOCKED',
    });
  });

  it('blocks a link nobody has requested, and takes out what it already covers', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('admin', 'admin');
    const playing = track('aaaaaaaaaaa');
    // Same channel as the track above, so blocking the artist covers both.
    const queued: MediaMetadata = { ...track('bbbbbbbbbbb'), providerArtistId: 'channel-aaaaaaaaaaa' };
    const never = track('ccccccccccc');
    resolveTracks(playing, queued, never);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, swagy, db);
    await enqueueMedia(MAIN_STATION_ID, queued.canonicalUrl, admin, db);
    const ruleId = await createRule(
      MAIN_STATION_ID,
      { name: 'No meme songs', description: '', enforcement: 'blocklist' },
      admin,
      db,
    );

    // A track the station has never seen, blocked before anyone asks for it.
    const blocked = await blockMediaByUrl(
      MAIN_STATION_ID,
      never.canonicalUrl,
      { ruleIds: [ruleId], entryType: 'track' },
      admin,
      db,
    );
    expect(blocked).toEqual({ label: 'Track ccccccccccc', removed: 0 });
    await expect(enqueueMedia(MAIN_STATION_ID, never.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'MEDIA_BLOCKED',
    });

    // Blocking the channel takes the waiting request out with it.
    const channel = await blockMediaByUrl(
      MAIN_STATION_ID,
      playing.canonicalUrl,
      { ruleIds: [ruleId], entryType: 'artist' },
      admin,
      db,
    );
    expect(channel.label).toBe('Test Artist');
    expect(channel.removed).toBe(1);
    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).queue).toEqual([]);
  });

  it('rejects a track that is already queued', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await expect(enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'ALREADY_QUEUED',
    });
  });

  it('rejects a track that started inside the repeat cooldown', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const moderator = await createUser('mod', 'mod');
    const recent = track('aaaaaaaaaaa');
    resolveTracks(recent);

    await enqueueMedia(MAIN_STATION_ID, recent.canonicalUrl, nathan, db);
    await skipCurrentTrack(MAIN_STATION_ID, 'Testing the repeat cooldown', moderator, db);

    await expect(enqueueMedia(MAIN_STATION_ID, recent.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'TRACK_RECENTLY_PLAYED',
      message: 'That track played less than a minute ago. Try again in 90 minutes.',
    });
  });

  it('tells the requester why a pending track was dropped at playback time', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const moderator = await createUser('mod', 'mod');
    const repeated = track('aaaaaaaaaaa');
    const filler = track('bbbbbbbbbbb');
    resolveTracks(repeated, filler);

    // Under a short cooldown the second request is accepted, which is the only
    // way to have one waiting when an admin raises the setting over it.
    await db.update(stationSettings).set({ repeatCooldownSeconds: 300 }).where(eq(stationSettings.stationId, MAIN_STATION_ID));
    const first = await enqueueMedia(MAIN_STATION_ID, repeated.canonicalUrl, nathan, db);
    await skipCurrentTrack(MAIN_STATION_ID, 'Making room for the filler', moderator, db);
    await db
      .update(queueItems)
      .set({ startedAt: new Date(Date.now() - 600_000) })
      .where(eq(queueItems.id, first.id));

    await enqueueMedia(MAIN_STATION_ID, filler.canonicalUrl, nathan, db);
    const pending = await enqueueMedia(MAIN_STATION_ID, repeated.canonicalUrl, swagy, db);
    await db
      .update(stationSettings)
      .set({ repeatCooldownSeconds: 5_400 })
      .where(eq(stationSettings.stationId, MAIN_STATION_ID));

    await skipCurrentTrack(MAIN_STATION_ID, 'Reaching the pending request', moderator, db);

    const dropped = await getStationSnapshot(MAIN_STATION_ID, swagy, 1, db);
    expect(dropped.myQueue).toEqual([]);
    expect(dropped.myNotices).toMatchObject([
      {
        queueItemId: pending.id,
        title: repeated.title,
        artist: repeated.artist,
        message: expect.stringContaining('Try again in'),
      },
    ]);

    // The internal log keeps its own wording, and nobody else is told.
    const [row] = await db
      .select({ reason: queueItems.moderationReason, status: queueItems.status })
      .from(queueItems)
      .where(eq(queueItems.id, pending.id));
    expect(row).toMatchObject({ status: 'removed' });
    expect(row?.reason).toContain('Automatic playback check:');
    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).myNotices).toEqual([]);

    await dismissQueueNotice(pending.id, swagy, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, swagy, 1, db)).myNotices).toEqual([]);
  });

  it('refuses to dismiss a notice that belongs to somebody else', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const queued = track('aaaaaaaaaaa');
    resolveTracks(queued);

    const mine = await enqueueMedia(MAIN_STATION_ID, queued.canonicalUrl, nathan, db);
    await db
      .update(queueItems)
      .set({ status: 'removed', listenerNotice: 'That track played moments ago.' })
      .where(eq(queueItems.id, mine.id));

    await expect(dismissQueueNotice(mine.id, swagy, db)).rejects.toMatchObject({
      code: 'NOTICE_NOT_FOUND',
    });
    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).myNotices).toHaveLength(1);
  });

  it('advances only after the playing track has run its duration', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa', 120);
    const next = track('bbbbbbbbbbb', 120);
    resolveTracks(playing, next);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(MAIN_STATION_ID, next.canonicalUrl, nathan, db);

    expect(await advanceIfExpired(MAIN_STATION_ID, db)).toBe(false);

    await db
      .update(queueItems)
      .set({ startedAt: new Date(Date.now() - 121_000) })
      .where(eq(queueItems.id, started.id));

    expect(await advanceIfExpired(MAIN_STATION_ID, db)).toBe(true);
    const [state] = await db
      .select({ currentQueueItemId: stationState.currentQueueItemId })
      .from(stationState)
      .where(eq(stationState.stationId, MAIN_STATION_ID));
    expect(state?.currentQueueItemId).toBe(promoted.id);
  });

  it('alternates turns between two people who both have tracks waiting', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [a1, a2, b1] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb'), track('ccccccccccc')];
    resolveTracks(a1, a2, b1);

    const first = await enqueueMedia(MAIN_STATION_ID, a1.canonicalUrl, nathan, db);
    const nathanSecond = await enqueueMedia(MAIN_STATION_ID, a2.canonicalUrl, nathan, db);
    const swagyFirst = await enqueueMedia(MAIN_STATION_ID, b1.canonicalUrl, swagy, db);

    // Nathan holds his seat while playing, so Swagy is genuinely next.
    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).queue.map((i) => i.id)).toEqual([
      swagyFirst.id,
      nathanSecond.id,
    ]);

    await advanceCurrentTrack(MAIN_STATION_ID, 'played', null, first.id, db);
    const afterFirst = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(afterFirst.current?.id).toBe(swagyFirst.id);
    expect(afterFirst.queue.map((i) => i.id)).toEqual([nathanSecond.id]);

    await advanceCurrentTrack(MAIN_STATION_ID, 'played', null, swagyFirst.id, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).current?.id).toBe(nathanSecond.id);
  });

  it('drops someone out of the rotation when their queue empties', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await advanceCurrentTrack(MAIN_STATION_ID, 'played', null, started.id, db);

    const seats = await db.select().from(schema.stationSeats).where(eq(schema.stationSeats.userId, nathan.id));
    expect(seats).toEqual([]);
  });

  it('keeps a personal queue in the order the owner sets', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing, second, third] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, second, third);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const b = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);
    const c = await enqueueMedia(MAIN_STATION_ID, third.canonicalUrl, nathan, db);

    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).myQueue.map((i) => i.id)).toEqual([b.id, c.id]);

    await reorderMyQueue([c.id, b.id], nathan, db);
    const reordered = await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db);
    expect(reordered.myQueue.map((i) => i.id)).toEqual([c.id, b.id]);
    // The station queue shows only their next one, which is now the reordered first.
    expect(reordered.queue.map((i) => i.id)).toEqual([c.id]);
  });

  it('lets someone take their own waiting track back out', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const waiting = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);

    await withdrawQueuedTrack(waiting.id, nathan, db);

    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).myQueue.map(({ id }) => id)).toEqual([]);
  });

  it('records nothing in the moderation log when someone withdraws their own track', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);
    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const waiting = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);

    await withdrawQueuedTrack(waiting.id, nathan, db);

    expect(await db.select().from(moderationActions)).toHaveLength(0);
  });

  it('drops someone out of the rotation once they withdraw their last track', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing, only] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, only);
    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const waiting = await enqueueMedia(MAIN_STATION_ID, only.canonicalUrl, nathan, db);

    await withdrawQueuedTrack(waiting.id, nathan, db);

    const seats = await db.select().from(schema.stationSeats).where(eq(schema.stationSeats.userId, nathan.id));
    expect(seats).toEqual([]);
  });

  it('refuses to withdraw a track belonging to someone else', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const theirs = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);

    await expect(withdrawQueuedTrack(theirs.id, swagy, db)).rejects.toMatchObject({
      code: 'NOT_YOUR_QUEUED_TRACK',
    });
    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).myQueue.map(({ id }) => id)).toEqual([theirs.id]);
  });

  it('refuses to withdraw the track that is already playing', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing] = [track('aaaaaaaaaaa')];
    resolveTracks(playing);
    // The first track enqueued into an idle station starts playing straight away.
    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db)).current?.id).toBe(started.id);

    await expect(withdrawQueuedTrack(started.id, nathan, db)).rejects.toMatchObject({
      code: 'NOT_YOUR_QUEUED_TRACK',
    });
  });

  it('refuses to reorder a track belonging to someone else', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const theirs = await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);

    await expect(reorderMyQueue([theirs.id], swagy, db)).rejects.toMatchObject({
      code: 'NOT_YOUR_TRACK',
    });
  });

  it('lets a moderator reorder the station rotation but keeps the current DJ last', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const peezy = await createUser('peezy');
    const moderator = await createUser('radio_mod', 'mod');
    const [playing, nathanNext, swagyNext, peezyNext] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
      track('ddddddddddd'),
    ];
    resolveTracks(playing, nathanNext, swagyNext, peezyNext);

    const current = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const swagyItem = await enqueueMedia(MAIN_STATION_ID, swagyNext.canonicalUrl, swagy, db);
    const peezyItem = await enqueueMedia(MAIN_STATION_ID, peezyNext.canonicalUrl, peezy, db);
    const nathanItem = await enqueueMedia(MAIN_STATION_ID, nathanNext.canonicalUrl, nathan, db);

    expect((await getStationSnapshot(MAIN_STATION_ID, moderator, 4, db)).queue.map(({ id }) => id)).toEqual([
      swagyItem.id,
      peezyItem.id,
      nathanItem.id,
    ]);

    await reorderStationQueue(MAIN_STATION_ID, [peezyItem.id, swagyItem.id, nathanItem.id], moderator, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, moderator, 4, db)).queue.map(({ id }) => id)).toEqual([
      peezyItem.id,
      swagyItem.id,
      nathanItem.id,
    ]);

    await expect(
      reorderStationQueue(MAIN_STATION_ID, [nathanItem.id, peezyItem.id, swagyItem.id], moderator, db),
    ).rejects.toMatchObject({ code: 'CURRENT_DJ_LOCKED' });

    await advanceCurrentTrack(MAIN_STATION_ID, 'played', null, current.id, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).current?.id).toBe(peezyItem.id);
    const actions = await db
      .select({ action: moderationActions.action })
      .from(moderationActions)
      .where(eq(moderationActions.actorUserId, moderator.id));
    expect(actions.map(({ action }) => action)).toEqual(['reorder_station_queue']);
  });

  it('lets an admin clear a whole personal queue', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const admin = await createUser('mod', 'admin');
    const [playing, second, third] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, second, third);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, nathan, db);
    await enqueueMedia(MAIN_STATION_ID, third.canonicalUrl, nathan, db);

    expect(await clearUserQueue(nathan.id, 'Queue full of memes', admin, db)).toBe(2);
    const snapshot = await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db);
    expect(snapshot.myQueue).toEqual([]);
    expect(snapshot.queue).toEqual([]);
    // The track already playing is left alone.
    expect(snapshot.current).not.toBeNull();
  });

  it('imports a playlist, reporting what it could not take', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const good = track('aaaaaaaaaaa');
    const alsoGood = track('bbbbbbbbbbb');
    const tooLong = track('ccccccccccc', 9_999);

    vi.mocked(listPlaylistTrackUrls).mockResolvedValue([
      good.canonicalUrl,
      alsoGood.canonicalUrl,
      tooLong.canonicalUrl,
    ]);
    resolveTracks(good, alsoGood, tooLong);

    const imported = await enqueueProviderPlaylist(
      MAIN_STATION_ID,
      'https://www.youtube.com/playlist?list=PL123',
      nathan,
      db,
    );

    expect(imported.added).toBe(2);
    expect(imported.skipped).toHaveLength(1);
    expect(imported.skipped[0]?.reason).toMatch(/minutes or shorter/);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, nathan, 1, db);
    expect(snapshot.current?.media.providerMediaId).toBe('aaaaaaaaaaa');
    expect(snapshot.myQueue.map((i) => i.media.providerMediaId)).toEqual(['bbbbbbbbbbb']);
  });

  it('refuses a track the playback host cannot reach', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const blocked = track('aaaaaaaaaaa');
    resolveTracks(blocked);
    playbackIssues.set(
      blocked.canonicalUrl,
      new MediaLookupError(
        'YOUTUBE_REGION_BLOCKED',
        'That video is not available to the playback host in AE.',
      ),
    );

    await expect(enqueueMedia(MAIN_STATION_ID, blocked.canonicalUrl, nathan, db)).rejects.toMatchObject({
      code: 'YOUTUBE_REGION_BLOCKED',
    });
  });

  it('refuses a playlist with nothing playable in it', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    vi.mocked(listPlaylistTrackUrls).mockResolvedValue([]);

    await expect(
      enqueueProviderPlaylist(MAIN_STATION_ID, 'https://www.youtube.com/playlist?list=PL123', nathan, db),
    ).rejects.toMatchObject({ code: 'PLAYLIST_EMPTY' });
  });

  it('refuses a vote on your own request', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await expect(voteOnCurrentTrack(started.id, 1, nathan, 10, db)).rejects.toMatchObject({
      code: 'OWN_TRACK',
    });
  });

  it('skips a track once enough of the station votes it down', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const [playing, next] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, next);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(MAIN_STATION_ID, next.canonicalUrl, nathan, db);
    await db.update(stationSettings).set({ skipDownvotes: 2 }).where(eq(stationSettings.stationId, MAIN_STATION_ID));

    const voters = [await createUser('one'), await createUser('two')];
    await voteOnCurrentTrack(started.id, -1, voters[0]!, 10, db);
    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).current?.id).toBe(started.id);

    await voteOnCurrentTrack(started.id, -1, voters[1]!, 10, db);
    const afterSkip = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(afterSkip.current?.id).toBe(promoted.id);
  });

  it('uses eligible signed-in station listeners for ratio skips', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const requester = await createUser('requester');
    const voter = await createUser('voter');
    const [playing, next] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, next);

    const started = await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, requester, db);
    const promoted = await enqueueMedia(MAIN_STATION_ID, next.canonicalUrl, requester, db);
    await db
      .update(stationSettings)
      .set({ skipMode: 'ratio', skipRatioPercent: 50 })
      .where(eq(stationSettings.stationId, MAIN_STATION_ID));

    await voteOnCurrentTrack(started.id, -1, voter, 2, db);

    expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).current?.id).toBe(promoted.id);
  });

  it('hides requesters while the station is blind, except from mods and admins', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const moderator = await createUser('mod', 'mod');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
    await enqueueMedia(MAIN_STATION_ID, second.canonicalUrl, swagy, db);
    await db.update(stationSettings).set({ revealRequester: false }).where(eq(stationSettings.stationId, MAIN_STATION_ID));

    const listener = await getStationSnapshot(MAIN_STATION_ID, swagy, 2, db);
    expect(listener.current?.requestedBy).toBeNull();
    // Your own track stays yours, since hiding it from you would be pointless.
    expect(listener.myQueue[0]?.requestedBy?.username).toBe('swagy_swagerson');

    const moderatorView = await getStationSnapshot(MAIN_STATION_ID, moderator, 2, db);
    expect(moderatorView.current?.requestedBy?.username).toBe('picklesnathan');
  });

  it('ranks selectors by the score their played tracks earned', async () => {
    await ensureStationExists(MAIN_STATION_ID, db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const liked = track('aaaaaaaaaaa');
    const disliked = track('bbbbbbbbbbb');
    resolveTracks(liked, disliked);

    const first = await enqueueMedia(MAIN_STATION_ID, liked.canonicalUrl, nathan, db);
    const second = await enqueueMedia(MAIN_STATION_ID, disliked.canonicalUrl, swagy, db);
    await voteOnCurrentTrack(first.id, 1, swagy, 10, db);
    await voteOnCurrentTrack(first.id, 1, admin, 10, db);
    await skipCurrentTrack(MAIN_STATION_ID, 'Next', admin, db);
    await voteOnCurrentTrack(second.id, -1, nathan, 10, db);

    const snapshot = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
    expect(snapshot.selectorStats.map((entry) => [entry.user.username, entry.score])).toEqual([
      ['picklesnathan', 2],
      ['swagy_swagerson', -1],
    ]);
  });

  describe('with more than one station', () => {
    it('plays each station from its own queue at the same time', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const swagy = await createUser('swagy_swagerson');
      const [mainTrack, otherTrack] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
      resolveTracks(mainTrack, otherTrack);

      const inMain = await enqueueMedia(MAIN_STATION_ID, mainTrack.canonicalUrl, nathan, db);
      const inOther = await enqueueMedia(other, otherTrack.canonicalUrl, swagy, db);

      const main = await getStationSnapshot(MAIN_STATION_ID, null, 0, db);
      const elsewhere = await getStationSnapshot(other, null, 0, db);
      expect(main.current?.id).toBe(inMain.id);
      expect(elsewhere.current?.id).toBe(inOther.id);
      expect(main.queue).toEqual([]);
      expect(elsewhere.queue).toEqual([]);
    });

    it('lets a listener queue in one station at a time', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const [first, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
      resolveTracks(first, second);

      const playing = await enqueueMedia(MAIN_STATION_ID, first.canonicalUrl, nathan, db);
      await expect(enqueueMedia(other, second.canonicalUrl, nathan, db)).rejects.toMatchObject({
        code: 'QUEUED_ELSEWHERE',
      });

      // Once the last track has played the seat is given up, and any station will do.
      await advanceCurrentTrack(MAIN_STATION_ID, 'played', null, playing.id, db);
      const moved = await enqueueMedia(other, second.canonicalUrl, nathan, db);
      expect((await getStationSnapshot(other, null, 0, db)).current?.id).toBe(moved.id);
    });

    it('keeps the repeat cooldown to the station the track played in', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const swagy = await createUser('swagy_swagerson');
      const moderator = await createUser('mod', 'mod');
      const repeated = track('aaaaaaaaaaa');
      resolveTracks(repeated);

      await enqueueMedia(MAIN_STATION_ID, repeated.canonicalUrl, nathan, db);
      await skipCurrentTrack(MAIN_STATION_ID, 'Done with it', moderator, db);

      await expect(
        enqueueMedia(MAIN_STATION_ID, repeated.canonicalUrl, swagy, db),
      ).rejects.toMatchObject({ code: 'TRACK_RECENTLY_PLAYED' });
      await expect(enqueueMedia(other, repeated.canonicalUrl, swagy, db)).resolves.toBeDefined();
    });

    it('enforces a rule only in the station that keeps it', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const swagy = await createUser('swagy_swagerson');
      const moderator = await createUser('mod', 'mod');
      const [playing, blocked] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
      resolveTracks(playing, blocked);
      const ruleId = await createRule(
        MAIN_STATION_ID,
        { name: 'Not here', description: '', enforcement: 'blocklist' },
        moderator,
        db,
      );

      await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, nathan, db);
      const waiting = await enqueueMedia(MAIN_STATION_ID, blocked.canonicalUrl, nathan, db);
      await blockQueueItemMedia(waiting.id, { ruleIds: [ruleId], entryType: 'track' }, moderator, db);

      await expect(
        enqueueMedia(MAIN_STATION_ID, blocked.canonicalUrl, swagy, db),
      ).rejects.toMatchObject({ code: 'MEDIA_BLOCKED' });
      await expect(enqueueMedia(other, blocked.canonicalUrl, swagy, db)).resolves.toBeDefined();
    });

    it("refuses to block under a rule the moderator cannot edit", async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const moderator = await createUser('mod', 'mod');
      // Moderates the other station, and nothing about the main station's rule.
      const otherMod = await createUser('other_mod');
      await db.insert(schema.stationMembers).values({ stationId: other, userId: otherMod.id, role: 'mod' });
      const blocked = track('aaaaaaaaaaa');
      resolveTracks(blocked);
      const ruleId = await createRule(
        MAIN_STATION_ID,
        { name: 'Main only', description: '', enforcement: 'blocklist' },
        moderator,
        db,
      );

      await expect(
        blockMediaByUrl(
          other,
          blocked.canonicalUrl,
          { ruleIds: [ruleId], entryType: 'track' },
          otherMod,
          db,
        ),
      ).rejects.toMatchObject({ code: 'RULE_EDIT_REQUIRED' });
      expect(await findBlockingRules(MAIN_STATION_ID, blocked, db)).toEqual([]);
    });

    it('moves a waiting queue to another station in order, leaving behind what that station refuses', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const swagy = await createUser('swagy_swagerson');
      const owner = await createUser('owner', 'admin');
      const [playing, first, refused, last] = [
        track('aaaaaaaaaaa'),
        track('bbbbbbbbbbb'),
        track('ccccccccccc', 400),
        track('ddddddddddd'),
      ];
      resolveTracks(playing, first, refused, last);
      // The other station only takes five minutes, so the long track stays behind.
      await db
        .update(stationSettings)
        .set({ maxDurationSeconds: 300 })
        .where(eq(stationSettings.stationId, other));

      // Somebody else is playing, so all of nathan's tracks are waiting.
      await enqueueMedia(MAIN_STATION_ID, playing.canonicalUrl, swagy, db);
      await enqueueMedia(MAIN_STATION_ID, first.canonicalUrl, nathan, db);
      await enqueueMedia(MAIN_STATION_ID, refused.canonicalUrl, nathan, db);
      await enqueueMedia(MAIN_STATION_ID, last.canonicalUrl, nathan, db);

      const plan = await planQueueMove(other, nathan, db);
      expect(plan.from).toEqual({ slug: 'main', name: 'DGG Radio' });
      expect(plan.tracks.map(({ title, refused: why }) => [title, why !== null])).toEqual([
        ['Track bbbbbbbbbbb', false],
        ['Track ccccccccccc', true],
        ['Track ddddddddddd', false],
      ]);

      await moveQueue(other, nathan, db);

      const there = await getStationSnapshot(other, nathan, 1, db);
      // Nothing was playing there, so the first moved track starts at once.
      expect(there.current?.media.title).toBe('Track bbbbbbbbbbb');
      expect(there.myQueue.map((item) => item.media.title)).toEqual(['Track ddddddddddd']);
      expect(there.myNotices.map((notice) => notice.title)).toEqual(['Track ccccccccccc']);
      const back = await getStationSnapshot(MAIN_STATION_ID, owner, 1, db);
      expect(back.queue).toEqual([]);
      expect(back.current?.media.title).toBe('Track aaaaaaaaaaa');
    });

    it('has nothing to move for somebody queued nowhere else', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');

      expect(await planQueueMove(other, nathan, db)).toEqual({ from: null, tracks: [] });
    });

    describe('sharing a rule', () => {
      async function blocklist(stationId: string, name: string, actor: AuthenticatedUser) {
        return createRule(stationId, { name, description: '', enforcement: 'blocklist' }, actor, db);
      }

      it('enforces a followed rule as its home station keeps it, later blocks included', async () => {
        await ensureStationExists(MAIN_STATION_ID, db);
        const other = await createStation('other');
        const moderator = await createUser('mod', 'mod');
        const nathan = await createUser('picklesnathan');
        const swagy = await createUser('swagy_swagerson');
        const [playing, later] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
        resolveTracks(playing, later);
        const ruleId = await blocklist(MAIN_STATION_ID, 'No memes', moderator);

        await followRule(other, ruleId, db);
        expect((await listActiveRules(other, db)).map(({ name, station }) => [name, station?.slug])).toEqual([
          ['No memes', 'main'],
        ]);

        // Waiting in the follower when the home station blocks it.
        await enqueueMedia(other, playing.canonicalUrl, nathan, db);
        const waiting = await enqueueMedia(other, later.canonicalUrl, swagy, db);
        await blockMediaByUrl(
          MAIN_STATION_ID,
          later.canonicalUrl,
          { ruleIds: [ruleId], entryType: 'track' },
          moderator,
          db,
        );

        const follower = await getStationSnapshot(other, swagy, 1, db);
        expect(follower.queue.map(({ id }) => id)).not.toContain(waiting.id);
        expect((await findBlockingRules(other, later, db)).map(({ ruleName }) => ruleName)).toEqual([
          'No memes',
        ]);
      });

      it('lets the home station, and whoever it grants, edit a list, and nobody else', async () => {
        await ensureStationExists(MAIN_STATION_ID, db);
        const other = await createStation('other');
        const moderator = await createUser('mod', 'mod');
        const outsider = await createUser('outsider');
        const otherMod = await createUser('other_mod');
        await db.insert(schema.stationMembers).values({ stationId: other, userId: otherMod.id, role: 'mod' });
        const ruleId = await blocklist(MAIN_STATION_ID, 'No memes', moderator);

        expect(await canEditRule(moderator, ruleId, db)).toBe(true);
        expect(await canEditRule(outsider, ruleId, db)).toBe(false);
        expect(await canEditRule(otherMod, ruleId, db)).toBe(false);

        await grantRuleEditor(ruleId, { username: 'OUTSIDER' }, moderator, db);
        await grantRuleEditor(ruleId, { station: 'other' }, moderator, db);
        expect(await canEditRule(outsider, ruleId, db)).toBe(true);
        expect(await canEditRule(otherMod, ruleId, db)).toBe(true);

        // Following gives a station the rule, not the right to edit it.
        const follower = await createStation('follower');
        const followerMod = await createUser('follower_mod');
        await db
          .insert(schema.stationMembers)
          .values({ stationId: follower, userId: followerMod.id, role: 'mod' });
        await followRule(follower, ruleId, db);
        expect(await canEditRule(followerMod, ruleId, db)).toBe(false);
      });

      it('logs every change to a list, and undoes each one once', async () => {
        await ensureStationExists(MAIN_STATION_ID, db);
        const moderator = await createUser('mod', 'mod');
        const blocked = track('aaaaaaaaaaa');
        resolveTracks(blocked);
        const ruleId = await blocklist(MAIN_STATION_ID, 'No memes', moderator);

        await blockMediaByUrl(
          MAIN_STATION_ID,
          blocked.canonicalUrl,
          { ruleIds: [ruleId], entryType: 'track' },
          moderator,
          db,
        );
        const [entry] = await listRuleEntries(ruleId, db);
        await removeRuleEntry(entry!.id, moderator, db);
        expect(await listRuleEntries(ruleId, db)).toEqual([]);

        const [removal, addition] = await listRuleChanges(ruleId, db);
        expect([removal!.action, addition!.action]).toEqual(['remove', 'add']);
        expect(removal!.actor).toBe('mod');

        await revertRuleChange(removal!.id, moderator, db);
        expect((await listRuleEntries(ruleId, db)).map(({ label }) => label)).toEqual([blocked.title]);
        await expect(revertRuleChange(removal!.id, moderator, db)).rejects.toMatchObject({
          code: 'CHANGE_REVERTED',
        });

        await revertRuleChange(addition!.id, moderator, db);
        expect(await listRuleEntries(ruleId, db)).toEqual([]);
      });

      it('copies a rule into a station as its own, and leaves it alone after', async () => {
        await ensureStationExists(MAIN_STATION_ID, db);
        const other = await createStation('other');
        const moderator = await createUser('mod', 'mod');
        const [first, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
        resolveTracks(first, second);
        const ruleId = await blocklist(MAIN_STATION_ID, 'No memes', moderator);
        await blockMediaByUrl(
          MAIN_STATION_ID,
          first.canonicalUrl,
          { ruleIds: [ruleId], entryType: 'track' },
          moderator,
          db,
        );

        const copyId = await copyRule(other, ruleId, moderator, db);
        await blockMediaByUrl(
          MAIN_STATION_ID,
          second.canonicalUrl,
          { ruleIds: [ruleId], entryType: 'track' },
          moderator,
          db,
        );

        expect((await listRuleEntries(copyId, db)).map(({ label }) => label)).toEqual([first.title]);
        await expect(copyRule(other, ruleId, moderator, db)).rejects.toMatchObject({
          code: 'RULE_EXISTS',
        });
      });
    });

    it('skips only the station whose track was skipped', async () => {
      await ensureStationExists(MAIN_STATION_ID, db);
      const other = await createStation('other');
      const nathan = await createUser('picklesnathan');
      const swagy = await createUser('swagy_swagerson');
      const moderator = await createUser('mod', 'mod');
      const [mainTrack, otherTrack] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
      resolveTracks(mainTrack, otherTrack);

      await enqueueMedia(MAIN_STATION_ID, mainTrack.canonicalUrl, nathan, db);
      const inOther = await enqueueMedia(other, otherTrack.canonicalUrl, swagy, db);
      await skipCurrentTrack(MAIN_STATION_ID, 'Not this one', moderator, db);

      expect((await getStationSnapshot(MAIN_STATION_ID, null, 0, db)).current).toBeNull();
      expect((await getStationSnapshot(other, null, 0, db)).current?.id).toBe(inOther.id);
    });
  });
});
