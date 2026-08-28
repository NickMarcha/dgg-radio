import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './auth';
import type { MediaMetadata } from './media';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:8787/api/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

vi.mock('./media-cache', () => ({ lookupMediaCached: vi.fn() }));

const { lookupMediaCached } = await import('./media-cache');
const {
  advanceCurrentTrack,
  advanceIfExpired,
  clearUserQueue,
  reorderMyQueue,
  blockQueueItemMedia,
  enqueueMedia,
  ensureRoomExists,
  getRoomSnapshot,
  RoomError,
  skipCurrentTrack,
  voteOnCurrentTrack,
} = await import('./room');
const { createRule } = await import('./rules');
const schema = await import('./db/schema');
const { media, moderationActions, queueItems, roomSettings, roomState, users } = schema;

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

describe.skipIf(!connectionString)('room transitions against Postgres', () => {
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
      sql`truncate table ${moderationActions}, ${schema.votes}, ${schema.ruleEntries}, ${schema.rules}, ${roomState}, ${schema.roomSettings}, ${queueItems}, ${media}, ${schema.sessions}, ${users} restart identity cascade`,
    );
    vi.mocked(lookupMediaCached).mockReset();
  });

  async function createUser(
    username: string,
    role: 'listener' | 'admin' = 'listener',
  ): Promise<AuthenticatedUser> {
    const [row] = await db
      .insert(users)
      .values({
        dggUserId: `dgg-${username}`,
        username,
        role,
        dggStatus: 'active',
      })
      .returning({
        id: users.id,
        username: users.username,
        role: users.role,
        avatarUrl: users.avatarUrl,
        team: users.team,
        dggUserId: users.dggUserId,
        dggRoles: users.dggRoles,
        dggFeatures: users.dggFeatures,
      });
    if (!row) throw new Error('Could not create the test user');
    return row;
  }

  function resolveTracks(...tracks: MediaMetadata[]): void {
    const byUrl = new Map(tracks.map((entry) => [entry.canonicalUrl, entry]));
    vi.mocked(lookupMediaCached).mockImplementation(async (url: string) => {
      const found = byUrl.get(url);
      if (!found) throw new Error(`No stubbed metadata for ${url}`);
      return found;
    });
  }

  it('starts the first request immediately and queues the rest', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const first = track('aaaaaaaaaaa');
    const second = track('bbbbbbbbbbb');
    resolveTracks(first, second);

    const started = await enqueueMedia(first.canonicalUrl, nathan, db);
    const queued = await enqueueMedia(second.canonicalUrl, nathan, db);

    const snapshot = await getRoomSnapshot(nathan, 1, db);
    expect(snapshot.current?.id).toBe(started.id);
    expect(snapshot.current?.media.providerMediaId).toBe('aaaaaaaaaaa');
    expect(snapshot.queue.map((item) => item.id)).toEqual([queued.id]);
  });

  it('gives a waiting requester the next turn before a second request from the same user', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [playing, nathanSecond, swagyFirst] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, nathanSecond, swagyFirst);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    const nathanQueued = await enqueueMedia(nathanSecond.canonicalUrl, nathan, db);
    const swagyQueued = await enqueueMedia(swagyFirst.canonicalUrl, swagy, db);

    const snapshot = await getRoomSnapshot(null, 0, db);
    expect(snapshot.queue.map((item) => item.id)).toEqual([swagyQueued.id, nathanQueued.id]);
  });

  it('counts votes on the playing track and clears them on a zero vote', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    await voteOnCurrentTrack(started.id, 1, swagy, 10, db);
    await voteOnCurrentTrack(started.id, -1, admin, 10, db);

    const withBothVotes = await getRoomSnapshot(swagy, 2, db);
    expect(withBothVotes.current).toMatchObject({ upvotes: 1, downvotes: 1, myVote: 1 });

    await voteOnCurrentTrack(started.id, 0, swagy, 10, db);
    const afterClearing = await getRoomSnapshot(swagy, 2, db);
    expect(afterClearing.current).toMatchObject({ upvotes: 0, downvotes: 1, myVote: 0 });
  });

  it('rejects a vote once the track is no longer playing', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    await skipCurrentTrack('Meme song', admin, db);

    await expect(voteOnCurrentTrack(started.id, 1, admin, 10, db)).rejects.toThrow(RoomError);
  });

  it('skips the current track, records the action, and starts the next one', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    const next = track('bbbbbbbbbbb');
    resolveTracks(playing, next);

    const skipped = await enqueueMedia(playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(next.canonicalUrl, nathan, db);
    await skipCurrentTrack('Rule 1: no memes', admin, db);

    const snapshot = await getRoomSnapshot(null, 0, db);
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
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const playing = track('aaaaaaaaaaa');
    const banned = track('bbbbbbbbbbb');
    resolveTracks(playing, banned);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    const queued = await enqueueMedia(banned.canonicalUrl, swagy, db);
    const ruleId = await createRule(
      { name: 'No meme songs', description: '', enforcement: 'blocklist' },
      admin,
      db,
    );
    await blockQueueItemMedia(queued.id, { ruleId, entryType: 'track' }, admin, db);

    const snapshot = await getRoomSnapshot(null, 0, db);
    expect(snapshot.queue).toEqual([]);
    await expect(enqueueMedia(banned.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'MEDIA_BLOCKED',
    });
  });

  it('rejects a track that is already queued', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    await expect(enqueueMedia(playing.canonicalUrl, swagy, db)).rejects.toMatchObject({
      code: 'ALREADY_QUEUED',
    });
  });

  it('advances only after the playing track has run its duration', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa', 120);
    const next = track('bbbbbbbbbbb', 120);
    resolveTracks(playing, next);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(next.canonicalUrl, nathan, db);

    expect(await advanceIfExpired(db)).toBe(false);

    await db
      .update(queueItems)
      .set({ startedAt: new Date(Date.now() - 121_000) })
      .where(eq(queueItems.id, started.id));

    expect(await advanceIfExpired(db)).toBe(true);
    const [state] = await db
      .select({ currentQueueItemId: roomState.currentQueueItemId })
      .from(roomState)
      .where(eq(roomState.id, 1));
    expect(state?.currentQueueItemId).toBe(promoted.id);
  });

  it('alternates turns between two people who both have tracks waiting', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [a1, a2, b1] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb'), track('ccccccccccc')];
    resolveTracks(a1, a2, b1);

    const first = await enqueueMedia(a1.canonicalUrl, nathan, db);
    const nathanSecond = await enqueueMedia(a2.canonicalUrl, nathan, db);
    const swagyFirst = await enqueueMedia(b1.canonicalUrl, swagy, db);

    // Nathan holds his seat while playing, so Swagy is genuinely next.
    expect((await getRoomSnapshot(null, 0, db)).queue.map((i) => i.id)).toEqual([
      swagyFirst.id,
      nathanSecond.id,
    ]);

    await advanceCurrentTrack('played', null, first.id, db);
    const afterFirst = await getRoomSnapshot(null, 0, db);
    expect(afterFirst.current?.id).toBe(swagyFirst.id);
    expect(afterFirst.queue.map((i) => i.id)).toEqual([nathanSecond.id]);

    await advanceCurrentTrack('played', null, swagyFirst.id, db);
    expect((await getRoomSnapshot(null, 0, db)).current?.id).toBe(nathanSecond.id);
  });

  it('drops someone out of the rotation when their queue empties', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    await advanceCurrentTrack('played', null, started.id, db);

    const [row] = await db.select({ seq: users.rotationSeq }).from(users).where(eq(users.id, nathan.id));
    expect(row?.seq).toBeNull();
  });

  it('keeps a personal queue in the order the owner sets', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const [playing, second, third] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, second, third);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    const b = await enqueueMedia(second.canonicalUrl, nathan, db);
    const c = await enqueueMedia(third.canonicalUrl, nathan, db);

    expect((await getRoomSnapshot(nathan, 1, db)).myQueue.map((i) => i.id)).toEqual([b.id, c.id]);

    await reorderMyQueue([c.id, b.id], nathan, db);
    const reordered = await getRoomSnapshot(nathan, 1, db);
    expect(reordered.myQueue.map((i) => i.id)).toEqual([c.id, b.id]);
    // The room queue shows only their next one, which is now the reordered first.
    expect(reordered.queue.map((i) => i.id)).toEqual([c.id]);
  });

  it('refuses to reorder a track belonging to someone else', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    const theirs = await enqueueMedia(second.canonicalUrl, nathan, db);

    await expect(reorderMyQueue([theirs.id], swagy, db)).rejects.toMatchObject({
      code: 'NOT_YOUR_TRACK',
    });
  });

  it('lets an admin clear a whole personal queue', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const admin = await createUser('mod', 'admin');
    const [playing, second, third] = [
      track('aaaaaaaaaaa'),
      track('bbbbbbbbbbb'),
      track('ccccccccccc'),
    ];
    resolveTracks(playing, second, third);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    await enqueueMedia(second.canonicalUrl, nathan, db);
    await enqueueMedia(third.canonicalUrl, nathan, db);

    expect(await clearUserQueue(nathan.id, 'Queue full of memes', admin, db)).toBe(2);
    const snapshot = await getRoomSnapshot(nathan, 1, db);
    expect(snapshot.myQueue).toEqual([]);
    expect(snapshot.queue).toEqual([]);
    // The track already playing is left alone.
    expect(snapshot.current).not.toBeNull();
  });

  it('refuses a vote on your own request', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const playing = track('aaaaaaaaaaa');
    resolveTracks(playing);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    await expect(voteOnCurrentTrack(started.id, 1, nathan, 10, db)).rejects.toMatchObject({
      code: 'OWN_TRACK',
    });
  });

  it('skips a track once enough of the room votes it down', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const [playing, next] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, next);

    const started = await enqueueMedia(playing.canonicalUrl, nathan, db);
    const promoted = await enqueueMedia(next.canonicalUrl, nathan, db);
    await db.update(roomSettings).set({ skipDownvotes: 2 }).where(eq(roomSettings.id, 1));

    const voters = [await createUser('one'), await createUser('two')];
    await voteOnCurrentTrack(started.id, -1, voters[0]!, 10, db);
    expect((await getRoomSnapshot(null, 0, db)).current?.id).toBe(started.id);

    await voteOnCurrentTrack(started.id, -1, voters[1]!, 10, db);
    const afterSkip = await getRoomSnapshot(null, 0, db);
    expect(afterSkip.current?.id).toBe(promoted.id);
  });

  it('hides requesters while the room is blind, except from admins', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const [playing, second] = [track('aaaaaaaaaaa'), track('bbbbbbbbbbb')];
    resolveTracks(playing, second);

    await enqueueMedia(playing.canonicalUrl, nathan, db);
    await enqueueMedia(second.canonicalUrl, swagy, db);
    await db.update(roomSettings).set({ revealRequester: false }).where(eq(roomSettings.id, 1));

    const listener = await getRoomSnapshot(swagy, 2, db);
    expect(listener.current?.requestedBy).toBeNull();
    // Your own track stays yours, since hiding it from you would be pointless.
    expect(listener.myQueue[0]?.requestedBy?.username).toBe('swagy_swagerson');

    const moderator = await getRoomSnapshot(admin, 2, db);
    expect(moderator.current?.requestedBy?.username).toBe('picklesnathan');
  });

  it('ranks selectors by the score their played tracks earned', async () => {
    await ensureRoomExists(db);
    const nathan = await createUser('picklesnathan');
    const swagy = await createUser('swagy_swagerson');
    const admin = await createUser('mod', 'admin');
    const liked = track('aaaaaaaaaaa');
    const disliked = track('bbbbbbbbbbb');
    resolveTracks(liked, disliked);

    const first = await enqueueMedia(liked.canonicalUrl, nathan, db);
    const second = await enqueueMedia(disliked.canonicalUrl, swagy, db);
    await voteOnCurrentTrack(first.id, 1, swagy, 10, db);
    await voteOnCurrentTrack(first.id, 1, admin, 10, db);
    await skipCurrentTrack('Next', admin, db);
    await voteOnCurrentTrack(second.id, -1, nathan, 10, db);

    const snapshot = await getRoomSnapshot(null, 0, db);
    expect(snapshot.selectorStats.map((entry) => [entry.user.username, entry.score])).toEqual([
      ['picklesnathan', 2],
      ['swagy_swagerson', -1],
    ]);
  });
});
