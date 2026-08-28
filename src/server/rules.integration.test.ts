import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from './auth';
import type { MediaMetadata } from './media';
import { testConnectionString } from './test-support';

process.env.DATABASE_URL ??= 'postgresql://unused';
process.env.APP_ORIGIN ??= 'http://localhost:4321';
process.env.DGG_CLIENT_ID ??= 'test-client';
process.env.DGG_CLIENT_SECRET ??= 'test-secret';
process.env.DGG_REDIRECT_URI ??= 'http://localhost:4321/auth/callback';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-key';

const {
  addRuleEntry,
  createRule,
  deleteRule,
  describeBlock,
  findBlockingRules,
  listActiveRules,
  listRuleEntries,
  listRules,
  reorderRules,
  RuleError,
  updateRule,
} = await import('./rules');
const schema = await import('./db/schema');
const { rules, ruleEntries, users, userChatCounts } = schema;

const connectionString = testConnectionString();

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
    await db.execute(sql`truncate table ${userChatCounts}, ${ruleEntries}, ${rules}, ${users} cascade`);
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
        topEmote: users.topEmote,
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
    expect(await findBlockingRules(track(), db)).toEqual([]);
  });

  it('blocks the exact track once it is listed, and names the rule', async () => {
    const ruleId = await blocklist('No meme songs');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'track', providerId: 'dQw4w9WgXcQ', label: 'A Track' },
      admin,
      db,
    );

    expect((await findBlockingRules(track(), db))[0]).toMatchObject({
      ruleName: 'No meme songs',
      entryType: 'track',
    });
    // A different track from the same channel is untouched by a track entry.
    expect(await findBlockingRules(track({ providerMediaId: 'other-video' }), db)).toEqual([]);
  });

  it('blocks every track from a listed artist', async () => {
    const ruleId = await blocklist('No music by that guy');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'artist', providerId: 'UC-channel-a', label: 'An Artist' },
      admin,
      db,
    );

    expect((await findBlockingRules(track({ providerMediaId: 'anything-else' }), db))[0]).toMatchObject({
      entryType: 'artist',
      label: 'An Artist',
    });
    // The collaboration case: same artist, released on someone else's channel.
    expect(await findBlockingRules(track({ providerArtistId: 'UC-channel-b' }), db)).toEqual([]);
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
    expect(await findBlockingRules(soundcloud, db)).toEqual([]);
  });

  it('never matches rows that predate artist ids', async () => {
    const ruleId = await blocklist('No music by that guy');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'artist', providerId: 'UC-channel-a', label: 'An Artist' },
      admin,
      db,
    );

    expect(await findBlockingRules(track({ providerArtistId: '' }), db)).toEqual([]);
  });

  it('stops enforcing a rule that is switched off, without losing its list', async () => {
    const ruleId = await blocklist('No meme songs');
    await addRuleEntry(
      ruleId,
      { provider: 'youtube', entryType: 'track', providerId: 'dQw4w9WgXcQ', label: 'A Track' },
      admin,
      db,
    );
    expect(await findBlockingRules(track(), db)).toHaveLength(1);

    await updateRule(ruleId, { active: false }, db);
    expect(await findBlockingRules(track(), db)).toEqual([]);
    expect(await listActiveRules(db)).toEqual([]);
    // The list survives, so switching it back on restores the block.
    expect((await listRules(db))[0]?.entryCount).toBe(1);

    await updateRule(ruleId, { active: true }, db);
    expect(await findBlockingRules(track(), db)).toHaveLength(1);
  });

  it('shows listeners only the rules that are switched on', async () => {
    const shown = await blocklist('No meme songs');
    const hidden = await createRule(
      { name: 'No Disney songs', description: '', enforcement: 'blocklist' },
      admin,
      db,
    );
    await updateRule(hidden, { active: false }, db);

    const visible = await listActiveRules(db);
    expect(visible.map(({ id }) => id)).toEqual([shown]);
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

  it('keeps a track blocked under every rule it breaks', async () => {
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

    const blocking = await findBlockingRules(track(), db);
    expect(blocking.map(({ ruleName }) => ruleName)).toEqual(['No meme songs', 'No Disney songs']);
    expect(describeBlock(blocking)).toBe('"No meme songs" and "No Disney songs"');
    expect((await listRules(db)).map(({ name, entryCount }) => [name, entryCount])).toEqual(
      expect.arrayContaining([
        ['No meme songs', 1],
        ['No Disney songs', 1],
      ]),
    );

    // Switching one off leaves the other still blocking it.
    await updateRule(memes, { active: false }, db);
    expect((await findBlockingRules(track(), db)).map(({ ruleName }) => ruleName)).toEqual([
      'No Disney songs',
    ]);
  });

  it('treats the same rule twice as one entry', async () => {
    const memes = await blocklist('No meme songs');
    const entry = {
      provider: 'youtube' as const,
      entryType: 'track' as const,
      providerId: 'dQw4w9WgXcQ',
      label: 'A Track',
    };

    await addRuleEntry(memes, { ...entry, note: 'first' }, admin, db);
    await addRuleEntry(memes, { ...entry, note: 'second' }, admin, db);

    expect((await listRules(db))[0]?.entryCount).toBe(1);
    const [stored] = await listRuleEntries(memes, db);
    expect(stored?.note).toBe('second');
    expect(await findBlockingRules(track(), db)).toHaveLength(1);
  });

  it('reorders the rule list, and shows listeners the same order', async () => {
    const actor = await makeAdmin();
    const first = await createRule({ name: 'First', description: '', enforcement: 'advisory' }, actor, db);
    const second = await createRule({ name: 'Second', description: '', enforcement: 'advisory' }, actor, db);
    const third = await createRule({ name: 'Third', description: '', enforcement: 'advisory' }, actor, db);
    expect((await listRules(db)).map(({ name }) => name)).toEqual(['First', 'Second', 'Third']);

    await reorderRules([third, first, second], db);

    expect((await listRules(db)).map(({ name }) => name)).toEqual(['Third', 'First', 'Second']);
    expect((await listActiveRules(db)).map(({ name }) => name)).toEqual(['Third', 'First', 'Second']);
  });

  it('refuses an order that does not name every rule', async () => {
    const actor = await makeAdmin();
    const first = await createRule({ name: 'First', description: '', enforcement: 'advisory' }, actor, db);
    await createRule({ name: 'Second', description: '', enforcement: 'advisory' }, actor, db);

    await expect(reorderRules([first], db)).rejects.toMatchObject({ code: 'RULES_CHANGED' });
    expect((await listRules(db)).map(({ name }) => name)).toEqual(['First', 'Second']);
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
    expect(await findBlockingRules(track(), db)).toEqual([]);
    expect(await db.select().from(ruleEntries)).toHaveLength(0);
  });
});
