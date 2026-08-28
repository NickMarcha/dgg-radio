import { asc, eq } from 'drizzle-orm';
import type { UserRole } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { users } from './db/schema';
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

  if (role === 'listener' && isRootAdmin(target.username)) {
    throw new AdminError(
      'ROOT_ADMIN',
      `${target.username} is configured as a root admin and cannot be removed here.`,
      403,
    );
  }

  await db.update(users).set({ role }).where(eq(users.id, userId));
}
