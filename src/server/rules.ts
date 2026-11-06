import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { rules, ruleEntries } from './db/schema';
import type { MediaMetadata } from './media';
import type {
  PublicRule,
  RuleEnforcement,
  RuleEntrySummary,
  RuleEntryType,
  RuleSummary,
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
  if (names.length <= 1) return names[0] ?? 'a room rule';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The one check that matters at request time: is this track, or the artist who
 * released it, on any rule's list. An artist entry covers everything they put
 * out, which is why a collaboration under another channel needs its own entry.
 */
export async function findBlockingRules(
  roomId: string,
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
        eq(rules.roomId, roomId),
        eq(rules.active, true),
        eq(ruleEntries.provider, metadata.provider),
        or(...targets),
      ),
    )
    .orderBy(asc(rules.position));
}

export async function listRules(
  roomId: string,
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
    .where(eq(rules.roomId, roomId))
    .groupBy(rules.id)
    .orderBy(asc(rules.position), asc(rules.name));
  return rows.map((row) => ({ ...row, entryCount: Number(row.entryCount) }));
}

/** What the player shows: the rules currently switched on. */
export async function listActiveRules(
  roomId: string,
  db: Database = getDatabase(),
): Promise<PublicRule[]> {
  return db
    .select({
      id: rules.id,
      name: rules.name,
      description: rules.description,
      enforcement: rules.enforcement,
    })
    .from(rules)
    .where(and(eq(rules.roomId, roomId), eq(rules.active, true)))
    .orderBy(asc(rules.position), asc(rules.name));
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
  roomId: string,
  input: { name: string; description: string; enforcement: RuleEnforcement },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<string> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${rules.position}), -1) + 1`.mapWith(Number) })
    .from(rules)
    .where(eq(rules.roomId, roomId));

  const [created] = await db
    .insert(rules)
    .values({ ...input, roomId, position: next, createdByUserId: admin.id })
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
 * Writes a new order for one room's whole rule list. The client sends every id,
 * so a list that changed underneath the admin is rejected rather than
 * half-applied.
 */
export async function reorderRules(
  roomId: string,
  orderedIds: string[],
  db: Database = getDatabase(),
): Promise<void> {
  await db.transaction(async (transaction) => {
    const existing = await transaction
      .select({ id: rules.id })
      .from(rules)
      .where(eq(rules.roomId, roomId));
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

/** The room that keeps a rule, which is whose moderators may edit it. */
export async function roomOfRule(ruleId: string, db: Database = getDatabase()): Promise<string> {
  const [rule] = await db.select({ roomId: rules.roomId }).from(rules).where(eq(rules.id, ruleId));
  if (!rule) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
  return rule.roomId;
}

/** The room that keeps the rule an entry is listed under. */
export async function roomOfRuleEntry(
  entryId: string,
  db: Database = getDatabase(),
): Promise<string> {
  const [entry] = await db
    .select({ roomId: rules.roomId })
    .from(ruleEntries)
    .innerJoin(rules, eq(ruleEntries.ruleId, rules.id))
    .where(eq(ruleEntries.id, entryId));
  if (!entry) throw new RuleError('ENTRY_NOT_FOUND', 'That entry does not exist.', 404);
  return entry.roomId;
}

/**
 * Refuses unless every rule named is one of this room's. A moderator blocks
 * under their own room's rules; a rule kept by another room is edited there.
 */
export async function assertRulesInRoom(
  roomId: string,
  ruleIds: string[],
  db: Database = getDatabase(),
): Promise<void> {
  if (ruleIds.length === 0) return;
  const found = await db
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.roomId, roomId), inArray(rules.id, ruleIds)));
  if (found.length !== new Set(ruleIds).size) {
    throw new RuleError('RULE_NOT_FOUND', 'That rule is not one of this room\'s.', 404);
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
  return created.id;
}

export async function removeRuleEntry(
  entryId: string,
  db: Database = getDatabase(),
): Promise<void> {
  const [removed] = await db
    .delete(ruleEntries)
    .where(eq(ruleEntries.id, entryId))
    .returning({ id: ruleEntries.id });
  if (!removed) throw new RuleError('ENTRY_NOT_FOUND', 'That entry does not exist.', 404);
}
