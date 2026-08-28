import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { AuthenticatedUser } from './auth';
import { getDatabase, type Database } from './db/client';
import { rules, ruleEntries } from './db/schema';
import type { MediaMetadata } from './media';
import type {
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

/**
 * The one check that matters at request time: is this track, or the artist who
 * released it, on any rule's list. An artist entry covers everything they put
 * out, which is why a collaboration under another channel needs its own entry.
 */
export async function findBlockingRule(
  metadata: MediaMetadata,
  db: Database = getDatabase(),
): Promise<BlockingRule | null> {
  const targets = [
    and(eq(ruleEntries.entryType, 'track'), eq(ruleEntries.providerId, metadata.providerMediaId)),
    // Rows predating artist ids carry an empty string, which must never match.
    metadata.providerArtistId
      ? and(eq(ruleEntries.entryType, 'artist'), eq(ruleEntries.providerId, metadata.providerArtistId))
      : undefined,
  ].filter(Boolean);

  const [blocked] = await db
    .select({
      ruleId: rules.id,
      ruleName: rules.name,
      entryType: ruleEntries.entryType,
      label: ruleEntries.label,
    })
    .from(ruleEntries)
    .innerJoin(rules, eq(ruleEntries.ruleId, rules.id))
    .where(and(eq(ruleEntries.provider, metadata.provider), or(...targets)))
    .limit(1);

  return blocked ?? null;
}

export async function listRules(db: Database = getDatabase()): Promise<RuleSummary[]> {
  const rows = await db
    .select({
      id: rules.id,
      name: rules.name,
      description: rules.description,
      enforcement: rules.enforcement,
      position: rules.position,
      entryCount: count(ruleEntries.id),
    })
    .from(rules)
    .leftJoin(ruleEntries, eq(ruleEntries.ruleId, rules.id))
    .groupBy(rules.id)
    .orderBy(asc(rules.position), asc(rules.name));
  return rows.map((row) => ({ ...row, entryCount: Number(row.entryCount) }));
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
  input: { name: string; description: string; enforcement: RuleEnforcement },
  admin: AuthenticatedUser,
  db: Database = getDatabase(),
): Promise<string> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${rules.position}), -1) + 1`.mapWith(Number) })
    .from(rules);

  const [created] = await db
    .insert(rules)
    .values({ ...input, position: next, createdByUserId: admin.id })
    .onConflictDoNothing()
    .returning({ id: rules.id });
  if (!created) throw new RuleError('RULE_EXISTS', 'A rule with that name already exists.');
  return created.id;
}

export async function updateRule(
  ruleId: string,
  input: Partial<{ name: string; description: string; enforcement: RuleEnforcement; position: number }>,
  db: Database = getDatabase(),
): Promise<void> {
  const [updated] = await db
    .update(rules)
    .set(input)
    .where(eq(rules.id, ruleId))
    .returning({ id: rules.id });
  if (!updated) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
}

export async function deleteRule(ruleId: string, db: Database = getDatabase()): Promise<void> {
  const [deleted] = await db
    .delete(rules)
    .where(eq(rules.id, ruleId))
    .returning({ id: rules.id });
  if (!deleted) throw new RuleError('RULE_NOT_FOUND', 'That rule does not exist.', 404);
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
      target: [ruleEntries.provider, ruleEntries.entryType, ruleEntries.providerId],
      set: { ruleId, label: entry.label, note: entry.note ?? null, addedByUserId: admin.id },
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

/** Track ids already blocked, used to drop matching items still sitting in queues. */
export async function blockedTrackIds(
  provider: 'youtube' | 'soundcloud',
  providerIds: string[],
  db: Database = getDatabase(),
): Promise<Set<string>> {
  if (providerIds.length === 0) return new Set();
  const rows = await db
    .select({ providerId: ruleEntries.providerId })
    .from(ruleEntries)
    .where(
      and(
        eq(ruleEntries.provider, provider),
        eq(ruleEntries.entryType, 'track'),
        inArray(ruleEntries.providerId, providerIds),
      ),
    );
  return new Set(rows.map(({ providerId }) => providerId));
}
