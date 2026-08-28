import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from './auth';
import type { MediaMetadata } from './media';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const { addRuleEntry, createRule, deleteRule, findBlockingRule, listRules, RuleError } =
  await import('./rules');
const schema = await import('./db/schema');
const { rules, ruleEntries, users } = schema;

const connectionString = process.env.TEST_DATABASE_URL;

function track(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    provider: 'youtube',
    providerMediaId: 'dQw4w9WgXcQ',
    providerArtistId: 'UC-channel-a',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'A Track',
    artist: 'An Artist',
    durationSeconds: 210,
    thumbnailUrl: null,
    ...overrides,
  };
}

describe.skipIf(!connectionString)('room rules', () => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  let admin: AuthenticatedUser;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.execute(sql`truncate table ${ruleEntries}, ${rules}, ${users} cascade`);
  });

  async function makeAdmin(): Promise<AuthenticatedUser> {
    const [row] = await db
      .insert(users)
      .values({ dggUserId: 'dgg-mod', username: 'mod', role: 'admin', dggStatus: 'active' })
      .onConflictDoUpdate({ target: users.dggUserId, set: { username: 'mod' } })
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
    admin = row!;
    return admin;
  }

  async function blocklist(name: string) {
    const actor = await makeAdmin();
    return createRule({ name, description: '', enforcement: 'blocklist' }, actor, db);
  }

  it('lets a track through when no rule covers it', async () => {
    await blocklist('No meme songs');
    expect(await findBlockingRule(track(), db)).toBeNull();
  });

  it('blocks the exact track once it is listed, and names the rule', async () => {
    const ruleId = await blocklist('No meme songs');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'track', providerId: 'dQw4w9WgXcQ', label: 'A Track' },
      admin,
      db,
    );

    expect(await findBlockingRule(track(), db)).toMatchObject({
      ruleName: 'No meme songs',
      entryType: 'track',
    });
    // A different track from the same channel is untouched by a track entry.
    expect(await findBlockingRule(track({ providerMediaId: 'other-video' }), db)).toBeNull();
  });

  it('blocks every track from a listed artist', async () => {
    const ruleId = await blocklist('No music by that guy');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'artist', providerId: 'UC-channel-a', label: 'An Artist' },
      admin,
      db,
    );

    expect(await findBlockingRule(track({ providerMediaId: 'anything-else' }), db)).toMatchObject({
      entryType: 'artist',
      label: 'An Artist',
    });
    // The collaboration case: same artist, released on someone else's channel.
    expect(await findBlockingRule(track({ providerArtistId: 'UC-channel-b' }), db)).toBeNull();
  });

  it('does not let one provider block the other', async () => {
    const ruleId = await blocklist('No meme songs');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'track', providerId: 'shared-id', label: 'A Track' },
      admin,
      db,
    );

    const soundcloud = track({ provider: 'soundcloud', providerMediaId: 'shared-id' });
    expect(await findBlockingRule(soundcloud, db)).toBeNull();
  });

  it('never matches rows that predate artist ids', async () => {
    const ruleId = await blocklist('No music by that guy');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'artist', providerId: 'UC-channel-a', label: 'An Artist' },
      admin,
      db,
    );

    expect(await findBlockingRule(track({ providerArtistId: '' }), db)).toBeNull();
  });

  it('refuses to keep a list on an advisory rule', async () => {
    const actor = await makeAdmin();
    const ruleId = await createRule(
      { name: 'Do not spam the chat', description: '', enforcement: 'advisory' },
      actor,
      db,
    );

    await expect(
      addRuleEntry(
        ruleId,
        { provider: 'youtube', entryType: 'track', providerId: 'x', label: 'x' },
        actor,
        db,
      ),
    ).rejects.toMatchObject({ code: 'RULE_NOT_ENFORCED' });
  });

  it('rejects a second rule with the same name', async () => {
    await blocklist('No meme songs');
    await expect(
      createRule({ name: 'no MEME songs', description: '', enforcement: 'blocklist' }, admin, db),
    ).rejects.toBeInstanceOf(RuleError);
  });

  it('moves an entry when it is blocked again under a different rule', async () => {
    const memes = await blocklist('No meme songs');
    const disney = await createRule(
      { name: 'No Disney songs', description: '', enforcement: 'blocklist' },
      admin,
      db,
    );
    const entry = {
      provider: 'youtube' as const,
      entryType: 'track' as const,
      providerId: 'dQw4w9WgXcQ',
      label: 'A Track',
    };

    await addRuleEntry(memes, entry, admin, db);
    await addRuleEntry(disney, entry, admin, db);

    expect(await findBlockingRule(track(), db)).toMatchObject({ ruleName: 'No Disney songs' });
    const counts = await listRules(db);
    expect(counts.map(({ name, entryCount }) => [name, entryCount])).toEqual(
      expect.arrayContaining([
        ['No meme songs', 0],
        ['No Disney songs', 1],
      ]),
    );
  });

  it('drops a rule together with everything it listed', async () => {
    const ruleId = await blocklist('No meme songs');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'track', providerId: 'dQw4w9WgXcQ', label: 'A Track' },
      admin,
      db,
    );

    await deleteRule(ruleId, db);
    expect(await findBlockingRule(track(), db)).toBeNull();
    expect(await db.select().from(ruleEntries)).toHaveLength(0);
  });
});
