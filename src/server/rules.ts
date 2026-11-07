import { and, asc, count, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import {
  ruleChanges,
  ruleEditors,
  ruleEntries,
  ruleFollows,
  rules,
  stationMembers,
  stations,
  users,
} from './db/schema';
import { stationRoleOf } from './stations';
import type { MediaMetadata } from './media';
import type {
  PublicRule,
  RuleChange,
  RuleEditor,
  RuleEnforcement,
  RuleEntrySummary,
  RuleEntryType,
  RuleSummary,
  SharedRule,
} from '../shared/contracts';

export class RuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}

export type { RuleEnforcement, RuleEntryType } from '../shared/contracts';

export interface BlockingRule {
  ruleId: string;
  ruleName: string;
  entryType: RuleEntryType;
  label: string;
}

/** Reads as "No meme songs", or "No meme songs and No Disney songs". */
export function describeBlock(blocking: BlockingRule[]): string {
  const names = [...new Set(blocking.map(({ ruleName }) => ruleName))].map((name) => `"${name}"`);
  if (names.length <= 1) return names[0] ?? 'a station rule';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The rules a station enforces: its own, and the ones it follows. */
function enforcedIn(stationId: string, db: Database) {
  return or(
    eq(rules.stationId, stationId),
    inArray(
      rules.id,
      db.select({ ruleId: ruleFollows.ruleId }).from(ruleFollows).where(eq(ruleFollows.stationId, stationId)),
    ),
  );
}

/** Every station a rule is enforced in: its home and every station following it. */
export async function stationsEnforcing(
  ruleIds: string[],
  db: Database = getDatabase(),
): Promise<string[]> {
  if (ruleIds.length === 0) return [];
  const [homes, followers] = await Promise.all([
    db.select({ stationId: rules.stationId }).from(rules).where(inArray(rules.id, ruleIds)),
    db
      .select({ stationId: ruleFollows.stationId })
      .from(ruleFollows)
      .where(inArray(ruleFollows.ruleId, ruleIds)),
  ]);
  return [...new Set([...homes, ...followers].map(({ stationId }) => stationId))];
}

/**
 * The one check that matters at request time: is this track, or the artist who
 * released it, on any rule's list. An artist entry covers everything they put
 * out, which is why a collaboration under another channel needs its own entry.
 */
export async function findBlockingRules(
  stationId: string,
  metadata: MediaMetadata,
  db: Database = getDatabase(),
): Promise<BlockingRule[]> {
  const targets = [
    and(eq(ruleEntries.entryType, 'track'), eq(ruleEntries.providerId, metadata.providerMediaId)),
    // Rows predating artist ids carry an empty string, which must never match.
    metadata.providerArtistId
      ? and(eq(ruleEntries.entryType, 'artist'), eq(ruleEntries.providerId, metadata.providerArtistId))
      : undefined,
  ].filter(Boolean);

  return db
    .select({
      ruleId: rules.id,
      ruleName: rules.name,
      entryType: ruleEntries.entryType,
      label: ruleEntries.label,
    })
    .from(ruleEntries)
    .innerJoin(rules, eq(ruleEntries.ruleId, rules.id))
    .where(
      and(
        enforcedIn(stationId, db),
        eq(rules.active, true),
        eq(ruleEntries.provider, metadata.provider),
        or(...targets),
      ),
    )
    .orderBy(asc(rules.position));
}

export async function listRules(
  stationId: string,
  db: Database = getDatabase(),
): Promise<RuleSummary[]> {
  const rows = await db
    .select({
      id: rules.id,
      name: rules.name,
      description: rules.description,
      enforcement: rules.enforcement,
      active: rules.active,
      position: rules.position,
      entryCount: count(ruleEntries.id),
    })
    .from(rules)
    .leftJoin(ruleEntries, eq(ruleEntries.ruleId, rules.id))
    .where(eq(rules.stationId, stationId))
    .groupBy(rules.id)
    .orderBy(asc(rules.position), asc(rules.name));
  return rows.map((row) => ({ ...row, entryCount: Number(row.entryCount) }));
}

/**
 * What the player shows: the rules switched on here, the station's own in the
 * order its owner set and then the ones it follows, each naming where it is
 * kept.
 */
export async function listActiveRules(
  stationId: string,
  db: Database = getDatabase(),
): Promise<PublicRule[]> {
  const rows = await db
    .select({
      id: rules.id,
      name: rules.name,
      description: rules.description,
      enforcement: rules.enforcement,
      homeId: stations.id,
      homeSlug: stations.slug,
      homeName: stations.name,
    })
    .from(rules)
    .innerJoin(stations, eq(stations.id, rules.stationId))
    .where(and(enforcedIn(stationId, db), eq(rules.active, true)))
    .orderBy(sql`${rules.stationId} <> ${stationId}`, asc(rules.position), asc(rules.name));
  return rows.map(({ homeId, homeSlug, homeName, ...rule }) => ({
    ...rule,
    station: homeId === stationId ? null : { slug: homeSlug, name: homeName },
  }));
}

export async function listRuleEntries(
  ruleId: string,
  db: Database = getDatabase(),
): Promise<RuleEntrySummary[]> {
  const rows = await db
    .select()
    .from(ruleEntries)
    .where(eq(ruleEntries.ruleId, ruleId))
    .orderBy(asc(ruleEntries.createdAt));
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    provider: row.provider,
    entryType: row.entryType,
    providerId: row.providerId,
    label: row.label,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createRule(
  stationId: string,
  input: { name: string; description: string; enforcement: RuleEnforcement },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<string> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${rules.position}), -1) + 1`.mapWith(Number) })
    .from(rules)
    .where(eq(rules.stationId, stationId));

  const [created] = await db
    .insert(rules)
    .values({ ...input, stationId, position: next, createdByUserId: admin.id })
    .onConflictDoNothing()
    .returning({ id: rules.id });
  if (!created) throw new RuleError('RULE_EXISTS', 'A rule with that name already exists.');
  return created.id;
}

export async function updateRule(
  ruleId: string,
  input: Partial<{
    name: string;
    description: string;
    enforcement: RuleEnforcement;
    active: boolean;
    position: number;
  }>,
  db: Database = getDatabase(),
): Promise<void> {
  const [updated] = await db
    .update(rules)
    .set(input)
    .where(eq(rules.id, ruleId))
    .returning({ id: rules.id });
  if (!updated) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
}

/**
 * Writes a new order for one station's whole rule list. The client sends every id,
 * so a list that changed underneath the admin is rejected rather than
 * half-applied.
 */
export async function reorderRules(
  stationId: string,
  orderedIds: string[],
  db: Database = getDatabase(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    const existing = await transaction
      .select({ id: rules.id })
      .from(rules)
      .where(eq(rules.stationId, stationId));
    const ids = new Set(existing.map(({ id }) => id));
    if (orderedIds.length !== ids.size || orderedIds.some((id) => !ids.has(id))) {
      throw new RuleError('RULES_CHANGED', 'The rule list changed. Try the move again.', 409);
    }
    for (const [position, id] of orderedIds.entries()) {
      await transaction.update(rules).set({ position }).where(eq(rules.id, id));
    }
  });
}

export async function deleteRule(ruleId: string, db: Database = getDatabase()): Promise<void> {
  const [deleted] = await db
    .delete(rules)
    .where(eq(rules.id, ruleId))
    .returning({ id: rules.id });
  if (!deleted) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
}

/** The station that keeps a rule, which is whose moderators may edit it. */
export async function stationOfRule(ruleId: string, db: Database = getDatabase()): Promise<string> {
  const [rule] = await db.select({ stationId: rules.stationId }).from(rules).where(eq(rules.id, ruleId));
  if (!rule) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
  return rule.stationId;
}

/** The rule an entry is listed under. */
export async function ruleOfEntry(entryId: string, db: Database = getDatabase()): Promise<string> {
  const [entry] = await db
    .select({ ruleId: ruleEntries.ruleId })
    .from(ruleEntries)
    .where(eq(ruleEntries.id, entryId));
  if (!entry) throw new RuleError('ENTRY_NOT_FOUND', 'That entry does not exist.', 404);
  return entry.ruleId;
}

/**
 * Whether someone may change a rule's list: anyone who runs its home station,
 * anyone it was granted to by name, and the owner and mods of a station it was
 * granted to. Site admins run every station, so they always may.
 */
export async function canEditRule(
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
  ruleId: string,
  db: Database = getDatabase(),
): Promise<boolean> {
  const home = await stationOfRule(ruleId, db);
  if ((await stationRoleOf(user, home, db)) !== null) return true;
  const [grant] = await db
    .select({ id: ruleEditors.id })
    .from(ruleEditors)
    .where(
      and(
        eq(ruleEditors.ruleId, ruleId),
        or(
          eq(ruleEditors.userId, user.id),
          inArray(
            ruleEditors.stationId,
            db
              .select({ stationId: stationMembers.stationId })
              .from(stationMembers)
              .where(eq(stationMembers.userId, user.id)),
          ),
        ),
      ),
    )
    .limit(1);
  return grant !== undefined;
}

/** Refuses unless the user may edit every rule named. */
export async function assertCanEditRules(
  user: Pick<AuthenticatedUser, 'id' | 'role'>,
  ruleIds: string[],
  db: Database = getDatabase(),
): Promise<void> {
  for (const ruleId of new Set(ruleIds)) {
    if (!(await canEditRule(user, ruleId, db))) {
      throw new RuleError('RULE_EDIT_REQUIRED', 'You cannot edit that rule\'s list.', 403);
    }
  }
}

export async function addRuleEntry(
  ruleId: string,
  entry: {
    provider: 'youtube' | 'soundcloud';
    entryType: RuleEntryType;
    providerId: string;
    label: string;
    note?: string | null;
  },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<string> {
  const [rule] = await db
    .select({ enforcement: rules.enforcement })
    .from(rules)
    .where(eq(rules.id, ruleId))
    .limit(1);
  if (!rule) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
  if (rule.enforcement !== 'blocklist') {
    throw new RuleError('RULE_NOT_ENFORCED', 'An advisory rule does not keep a list.');
  }
  if (!entry.providerId) {
    throw new RuleError('ENTRY_NOT_IDENTIFIED', 'That track has no stored id to block.');
  }

  const [created] = await db
    .insert(ruleEntries)
    .values({ ...entry, ruleId, addedByUserId: admin.id })
    .onConflictDoUpdate({
      target: [
        ruleEntries.ruleId,
        ruleEntries.provider,
        ruleEntries.entryType,
        ruleEntries.providerId,
      ],
      set: { label: entry.label, note: entry.note ?? null, addedByUserId: admin.id },
    })
    .returning({ id: ruleEntries.id });
  if (!created) throw new RuleError('ENTRY_FAILED', 'The entry could not be saved.', 500);
  await db.insert(ruleChanges).values({
    ruleId,
    action: 'add',
    provider: entry.provider,
    entryType: entry.entryType,
    providerId: entry.providerId,
    label: entry.label,
    note: entry.note ?? null,
    actorUserId: admin.id,
  });
  return created.id;
}

export async function removeRuleEntry(
  entryId: string,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const [removed] = await db.delete(ruleEntries).where(eq(ruleEntries.id, entryId)).returning();
  if (!removed) throw new RuleError('ENTRY_NOT_FOUND', 'That entry does not exist.', 404);
  await db.insert(ruleChanges).values({
    ruleId: removed.ruleId,
    action: 'remove',
    provider: removed.provider,
    entryType: removed.entryType,
    providerId: removed.providerId,
    label: removed.label,
    note: removed.note,
    actorUserId: actor.id,
  });
}

/** The latest changes to a rule's list, newest first. */
export async function listRuleChanges(
  ruleId: string,
  db: Database = getDatabase(),
): Promise<RuleChange[]> {
  const rows = await db
    .select({
      id: ruleChanges.id,
      action: ruleChanges.action,
      entryType: ruleChanges.entryType,
      label: ruleChanges.label,
      note: ruleChanges.note,
      actor: users.username,
      createdAt: ruleChanges.createdAt,
      revertedAt: ruleChanges.revertedAt,
    })
    .from(ruleChanges)
    .leftJoin(users, eq(users.id, ruleChanges.actorUserId))
    .where(eq(ruleChanges.ruleId, ruleId))
    .orderBy(desc(ruleChanges.createdAt))
    .limit(100);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    revertedAt: row.revertedAt?.toISOString() ?? null,
  }));
}

/** The rule a logged change was made to, which is whose owner may undo it. */
export async function ruleOfChange(changeId: string, db: Database = getDatabase()): Promise<string> {
  const [change] = await db
    .select({ ruleId: ruleChanges.ruleId })
    .from(ruleChanges)
    .where(eq(ruleChanges.id, changeId));
  if (!change) throw new RuleError('CHANGE_NOT_FOUND', 'That change is not in the log.', 404);
  return change.ruleId;
}

/**
 * Undoes one logged change: an added entry comes off the list, a removed one
 * goes back on. Each change is undone at most once, and undoing it is not
 * itself logged as a new change, because the log already records that it was
 * undone and by whom.
 */
export async function revertRuleChange(
  changeId: string,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [change] = await transaction
      .select()
      .from(ruleChanges)
      .where(eq(ruleChanges.id, changeId))
      .for('update');
    if (!change) throw new RuleError('CHANGE_NOT_FOUND', 'That change is not in the log.', 404);
    if (change.revertedAt) throw new RuleError('CHANGE_REVERTED', 'That change was already undone.', 409);

    const target = and(
      eq(ruleEntries.ruleId, change.ruleId),
      eq(ruleEntries.provider, change.provider),
      eq(ruleEntries.entryType, change.entryType),
      eq(ruleEntries.providerId, change.providerId),
    );
    if (change.action === 'add') {
      await transaction.delete(ruleEntries).where(target);
    } else {
      await transaction
        .insert(ruleEntries)
        .values({
          ruleId: change.ruleId,
          provider: change.provider,
          entryType: change.entryType,
          providerId: change.providerId,
          label: change.label,
          note: change.note,
          addedByUserId: actor.id,
        })
        .onConflictDoNothing();
    }
    await transaction
      .update(ruleChanges)
      .set({ revertedAt: new Date(), revertedByUserId: actor.id })
      .where(eq(ruleChanges.id, changeId));
  });
}

/** Who besides the home station may edit a rule. */
export async function listRuleEditors(
  ruleId: string,
  db: Database = getDatabase(),
): Promise<RuleEditor[]> {
  const rows = await db
    .select({
      id: ruleEditors.id,
      username: users.username,
      stationSlug: stations.slug,
      stationName: stations.name,
    })
    .from(ruleEditors)
    .leftJoin(users, eq(users.id, ruleEditors.userId))
    .leftJoin(stations, eq(stations.id, ruleEditors.stationId))
    .where(eq(ruleEditors.ruleId, ruleId))
    .orderBy(asc(ruleEditors.createdAt));
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    station: row.stationSlug ? { slug: row.stationSlug, name: row.stationName ?? '' } : null,
  }));
}

/** Grants edit access on a rule to one person by name, or to a whole station by its slug. */
export async function grantRuleEditor(
  ruleId: string,
  grantee: { username: string } | { station: string },
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<void> {
  const home = await stationOfRule(ruleId, db);
  if ('username' in grantee) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${grantee.username.trim()})`)
      .limit(1);
    if (!user) {
      throw new RuleError('USER_NOT_FOUND', 'Nobody by that name has signed in to the radio yet.', 404);
    }
    await db
      .insert(ruleEditors)
      .values({ ruleId, userId: user.id, addedByUserId: actor.id })
      .onConflictDoNothing();
    return;
  }
  const [station] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(eq(stations.slug, grantee.station.trim().toLowerCase()));
  if (!station) throw new RuleError('STATION_NOT_FOUND', 'That station does not exist.', 404);
  if (station.id === home) {
    throw new RuleError('RULE_HOME', 'That station already keeps this rule.', 409);
  }
  await db
    .insert(ruleEditors)
    .values({ ruleId, stationId: station.id, addedByUserId: actor.id })
    .onConflictDoNothing();
}

/** Takes a grant back. */
export async function revokeRuleEditor(
  editorId: string,
  db: Database = getDatabase(),
): Promise<void> {
  const [removed] = await db
    .delete(ruleEditors)
    .where(eq(ruleEditors.id, editorId))
    .returning({ id: ruleEditors.id });
  if (!removed) throw new RuleError('EDITOR_NOT_FOUND', 'That grant does not exist.', 404);
}

/** The rule a grant is on, which is whose owner may take it back. */
export async function ruleOfEditor(editorId: string, db: Database = getDatabase()): Promise<string> {
  const [grant] = await db
    .select({ ruleId: ruleEditors.ruleId })
    .from(ruleEditors)
    .where(eq(ruleEditors.id, editorId));
  if (!grant) throw new RuleError('EDITOR_NOT_FOUND', 'That grant does not exist.', 404);
  return grant.ruleId;
}

/**
 * Every other station's active rules, for this station to follow or copy,
 * with whether it already follows each.
 */
export async function listSharedRules(
  stationId: string,
  db: Database = getDatabase(),
): Promise<SharedRule[]> {
  const rows = await db
    .select({
      id: rules.id,
      name: rules.name,
      description: rules.description,
      enforcement: rules.enforcement,
      stationSlug: stations.slug,
      stationName: stations.name,
      entryCount: sql<number>`(select count(*) from ${ruleEntries} where ${ruleEntries.ruleId} = ${rules.id})`.mapWith(Number),
      followed: sql<boolean>`exists (select 1 from ${ruleFollows} where ${ruleFollows.ruleId} = ${rules.id} and ${ruleFollows.stationId} = ${stationId})`,
    })
    .from(rules)
    .innerJoin(stations, eq(stations.id, rules.stationId))
    .where(and(ne(rules.stationId, stationId), eq(rules.active, true)))
    .orderBy(asc(stations.name), asc(rules.position));
  return rows.map(({ stationSlug, stationName, ...rule }) => ({
    ...rule,
    station: { slug: stationSlug, name: stationName },
  }));
}

/** Enforces another station's rule here, as it is kept there. */
export async function followRule(
  stationId: string,
  ruleId: string,
  db: Database = getDatabase(),
): Promise<void> {
  if ((await stationOfRule(ruleId, db)) === stationId) {
    throw new RuleError('RULE_HOME', 'This station already keeps that rule.', 409);
  }
  await db.insert(ruleFollows).values({ stationId, ruleId }).onConflictDoNothing();
}

export async function unfollowRule(
  stationId: string,
  ruleId: string,
  db: Database = getDatabase(),
): Promise<void> {
  await db
    .delete(ruleFollows)
    .where(and(eq(ruleFollows.stationId, stationId), eq(ruleFollows.ruleId, ruleId)));
}

/**
 * Copies another station's rule and its list into this one, as a rule of its
 * own from then on. The copy is placed last, and refused when this station
 * already has a rule by that name.
 */
export async function copyRule(
  stationId: string,
  ruleId: string,
  actor: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<string> {
  return db.transaction(async (transaction) => {
    const [source] = await transaction.select().from(rules).where(eq(rules.id, ruleId));
    if (!source) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
    if (source.stationId === stationId) {
      throw new RuleError('RULE_HOME', 'This station already keeps that rule.', 409);
    }
    const [{ next }] = await transaction
      .select({ next: sql<number>`coalesce(max(${rules.position}), -1) + 1`.mapWith(Number) })
      .from(rules)
      .where(eq(rules.stationId, stationId));
    const [copy] = await transaction
      .insert(rules)
      .values({
        stationId,
        name: source.name,
        description: source.description,
        enforcement: source.enforcement,
        position: next,
        createdByUserId: actor.id,
      })
      .onConflictDoNothing()
      .returning({ id: rules.id });
    if (!copy) throw new RuleError('RULE_EXISTS', 'This station already has a rule by that name.');
    await transaction.execute(sql`
      insert into ${ruleEntries} (rule_id, provider, entry_type, provider_id, label, note, added_by_user_id)
      select ${copy.id}, provider, entry_type, provider_id, label, note, ${actor.id}
      from ${ruleEntries} where rule_id = ${ruleId}
    `);
    return copy.id;
  });
}
