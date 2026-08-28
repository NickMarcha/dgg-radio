import { asc, desc, eq, ilike, sql } from 'drizzle-orm';
import type { RoomMember, UserRole } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { queueItems, users } from './db/schema';
import { getAdminUsernames, getEnv } from './env';

export class AdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface AdminSummary {
  id: string;
  username: string;
  avatarUrl: string | null;
  role: UserRole;
  /** Named in the environment. Always an admin, and cannot be demoted here. */
  isRoot: boolean;
  lastSeenAt: string;
}

/**
 * Root admins come from ADMIN_DGG_USERNAMES. Everyone else is promoted through
 * the admin page, so the database is the source of truth for them.
 */
export function isRootAdmin(username: string): boolean {
  return getAdminUsernames(getEnv()).has(username.toLowerCase());
}

export async function listAdmins(db: Database = getDatabase()): Promise<AdminSummary[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.username));

  return rows.map((row) => ({
    ...row,
    isRoot: isRootAdmin(row.username),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

/**
 * People an admin might act on, newest activity first, each with how much they
 * have waiting so a queue worth clearing is visible without drilling in.
 */
export async function listUsers(
  search: string | undefined,
  db: Database = getDatabase(),
): Promise<RoomMember[]> {
  const queued = db.$with('queued').as(
    db
      .select({
        userId: queueItems.requestedByUserId,
        queuedCount: sql<number>`count(*)`.mapWith(Number).as('queued_count'),
      })
      .from(queueItems)
      .where(eq(queueItems.status, 'queued'))
      .groupBy(queueItems.requestedByUserId),
  );

  const rows = await db
    .with(queued)
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      team: users.team,
      topEmote: users.topEmote,
      lastSeenAt: users.lastSeenAt,
      queuedCount: sql<number>`coalesce(${queued.queuedCount}, 0)`.mapWith(Number),
    })
    .from(users)
    .leftJoin(queued, eq(queued.userId, users.id))
    .where(search ? ilike(users.username, `%${search}%`) : undefined)
    .orderBy(desc(users.lastSeenAt))
    .limit(50);

  return rows.map((row) => ({
    ...row,
    isRoot: isRootAdmin(row.username),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

export async function setUserRole(
  userId: string,
  role: UserRole,
  db: Database = getDatabase(),
): Promise<void> {
  const [target] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) throw new AdminError('USER_NOT_FOUND', 'That user does not exist.', 404);

  if (role !== 'admin' && isRootAdmin(target.username)) {
    throw new AdminError(
      'ROOT_ADMIN',
      `${target.username} is configured as a root admin and cannot be removed here.`,
      403,
    );
  }

  await db.update(users).set({ role }).where(eq(users.id, userId));
}
