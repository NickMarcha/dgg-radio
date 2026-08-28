import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { z } from 'zod';
import type { RoomUser, UserRole } from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { oauthLoginTransactions, sessions, users } from './db/schema';
import { getAdminUsernames, getEnv, type ServerEnv } from './env';

const SESSION_COOKIE = 'dgg_radio_session';
const LOGIN_TTL_MS = 5 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const dggTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive(),
  scope: z.string(),
  token_type: z.string(),
});

const dggUserInfoSchema = z.object({
  nick: z.string(),
  username: z.string().min(1),
  userId: z.union([z.number(), z.string()]).transform(String),
  status: z.string(),
  createdDate: z.string(),
  roles: z.array(z.string()),
  features: z.array(z.string()),
  subscription: z.unknown().nullable().optional(),
});

export type AuthenticatedUser = RoomUser & {
  dggUserId: string;
  dggRoles: string[];
  dggFeatures: string[];
};

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function buildDggCodeChallenge(codeVerifier: string, clientSecret: string): string {
  const secretHash = sha256Hex(clientSecret);
  const challengeDigestHex = sha256Hex(codeVerifier + secretHash);
  return Buffer.from(challengeDigestHex, 'utf8').toString('base64');
}

export function teamFromFeatures(features: string[]): 'pepe' | 'yee' | null {
  const hasPepe = features.includes('flair35');
  const hasYee = features.includes('flair36');
  if (hasPepe === hasYee) return null;
  return hasPepe ? 'pepe' : 'yee';
}

export function radioRole(
  username: string,
  roles: string[],
  env: ServerEnv,
): UserRole {
  const configuredAdmin = getAdminUsernames(env).has(username.toLowerCase());
  if (roles.includes('ADMIN') || configuredAdmin) return 'admin';
  return roles.includes('MODERATOR') ? 'mod' : 'listener';
}

export function canModerate(role: UserRole): boolean {
  return role === 'mod' || role === 'admin';
}

export async function createAuthorizationUrl(
  db: Database = getDatabase(),
  env: ServerEnv = getEnv(),
): Promise<string> {
  const state = randomBytes(32).toString('hex');
  const verifier = randomToken(48);
  const now = new Date();

  await db.delete(oauthLoginTransactions).where(lt(oauthLoginTransactions.expiresAt, now));
  await db.insert(oauthLoginTransactions).values({
    stateHash: sha256Hex(state),
    codeVerifier: verifier,
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS),
  });

  const authorizeUrl = new URL('https://www.destiny.gg/oauth/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', env.DGG_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', env.DGG_REDIRECT_URI);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', buildDggCodeChallenge(verifier, env.DGG_CLIENT_SECRET));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  return authorizeUrl.toString();
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  env: ServerEnv,
): Promise<string> {
  const tokenUrl = new URL('https://www.destiny.gg/oauth/token');
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  tokenUrl.searchParams.set('code', code);
  tokenUrl.searchParams.set('client_id', env.DGG_CLIENT_ID);
  tokenUrl.searchParams.set('redirect_uri', env.DGG_REDIRECT_URI);
  tokenUrl.searchParams.set('code_verifier', verifier);

  const response = await fetch(tokenUrl, { signal: AbortSignal.timeout(8_000) });
  const body: unknown = await response.json().catch(() => null);
  const token = dggTokenResponseSchema.safeParse(body);
  if (!response.ok || !token.success) {
    throw new AuthenticationError('Destiny could not complete the login.');
  }
  return token.data.access_token;
}

async function fetchDggIdentity(accessToken: string) {
  const userInfoUrl = new URL('https://www.destiny.gg/api/userinfo');
  userInfoUrl.searchParams.set('token', accessToken);

  const response = await fetch(userInfoUrl, { signal: AbortSignal.timeout(8_000) });
  const body: unknown = await response.json().catch(() => null);
  const identity = dggUserInfoSchema.safeParse(body);
  if (!response.ok || !identity.success) {
    throw new AuthenticationError('Destiny returned an invalid user profile.');
  }
  return identity.data;
}

async function consumeLoginTransaction(
  state: string,
  db: Database,
): Promise<string> {
  const [transaction] = await db
    .delete(oauthLoginTransactions)
    .where(
      and(
        eq(oauthLoginTransactions.stateHash, sha256Hex(state)),
        gt(oauthLoginTransactions.expiresAt, new Date()),
      ),
    )
    .returning({ codeVerifier: oauthLoginTransactions.codeVerifier });

  if (!transaction) {
    throw new AuthenticationError('This login attempt expired or was already used.');
  }
  return transaction.codeVerifier;
}

export async function completeAuthorization(
  code: string,
  state: string,
  db: Database = getDatabase(),
  env: ServerEnv = getEnv(),
): Promise<{ sessionToken: string; expiresAt: Date; userId: string }> {
  const verifier = await consumeLoginTransaction(state, db);
  const accessToken = await exchangeAuthorizationCode(code, verifier, env);
  const identity = await fetchDggIdentity(accessToken);
  const role = radioRole(identity.username, identity.roles, env);
  const team = teamFromFeatures(identity.features);

  const [user] = await db
    .insert(users)
    .values({
      dggUserId: identity.userId,
      username: identity.username,
      dggStatus: identity.status,
      dggRoles: identity.roles,
      dggFeatures: identity.features,
      role,
      team,
    })
    .onConflictDoUpdate({
      target: users.dggUserId,
      set: {
        username: identity.username,
        dggStatus: identity.status,
        dggRoles: identity.roles,
        dggFeatures: identity.features,
        // Sign-in can promote from Destiny roles, but never demotes a role an
        // admin granted inside the radio.
        role:
          role === 'admin'
            ? 'admin'
            : role === 'mod'
              ? sql`case when ${users.role} = 'listener' then 'mod'::user_role else ${users.role} end`
              : sql`${users.role}`,
        team,
        lastSeenAt: new Date(),
      },
    })
    .returning({ id: users.id });

  if (!user) throw new AuthenticationError('The local account could not be created.');

  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash: sha256Hex(sessionToken),
    userId: user.id,
    expiresAt,
  });

  return { sessionToken, expiresAt, userId: user.id };
}

export function setSessionCookie(context: Context, token: string, expiresAt: Date): void {
  const env = getEnv();
  setCookie(context, SESSION_COOKIE, token, {
    expires: expiresAt,
    httpOnly: true,
    path: '/',
    sameSite: env.APP_ORIGIN.startsWith('https://') ? 'None' : 'Lax',
    secure: env.APP_ORIGIN.startsWith('https://'),
  });
}

export async function clearSession(context: Context, db: Database = getDatabase()): Promise<void> {
  const token = getCookie(context, SESSION_COOKIE);
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
  }
  deleteCookie(context, SESSION_COOKIE, { path: '/' });
}

export async function getSessionUser(
  context: Context,
  db: Database = getDatabase(),
): Promise<AuthenticatedUser | null> {
  const token = getCookie(context, SESSION_COOKIE);
  return token ? getSessionUserByToken(token, db) : null;
}

export async function getSessionUserByToken(
  token: string,
  db: Database = getDatabase(),
): Promise<AuthenticatedUser | null> {
  const [result] = await db
    .select({
      id: users.id,
      dggUserId: users.dggUserId,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      team: users.team,
      dggRoles: users.dggRoles,
      dggFeatures: users.dggFeatures,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return result ?? null;
}

export function readSessionTokenFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}
