import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase, type Database } from './db/client';
import { userChatCounts, users } from './db/schema';
import type { Team } from '../shared/contracts';

/**
 * What someone is like in Destiny chat, counted through polecat.me. That API
 * makes no uptime promise and may change without warning, so every failure here
 * is soft: the stored counts are left alone rather than cleared.
 */
const POLECAT_SEARCH = 'https://polecat.me/api/stalksearch';

/** A clear majority, rather than a bare one, decides a side. */
const MAJORITY = 0.75;

/** Counted for the team split. */
const TEAM_TERMS = ['yee', 'pepe'] as const;

/**
 * The dancing and music emotes in public/emotes, which is where their images
 * live. The server image does not carry public/, and the emote manifest beside
 * them is the whole destiny.gg catalogue rather than this subset, so the list
 * has to be written out here. Adding an emote to the interface means adding it
 * to this list as well.
 *
 * NODDERS, NOPERS, Skip, SURPRISE, YEE and TeddYEE are deliberately absent:
 * they are reactions rather than dancing, and YEE would double-count the team
 * term above.
 */
export const DANCING_EMOTES = [
  'AlienPls',
  'CamOnIngerland',
  'GatoPls',
  'Listening',
  'RainbowPls',
  'RaveDoge',
  'YAM',
  'catJAM',
  'pepeJAM',
] as const;

const COUNTED_TERMS = [...TEAM_TERMS, ...DANCING_EMOTES];

const countSchema = z.object({ count: z.number().int().nonnegative() });

export class ChatLookupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'ChatLookupError';
  }
}

/**
 * Someone who has said neither word has no side. Everyone else is placed by
 * whichever word they use at least three times out of four.
 */
export function teamFromCounts(yee: number, pepe: number): Team {
  const total = yee + pepe;
  if (total === 0) return null;
  if (yee / total >= MAJORITY) return 'yee';
  if (pepe / total >= MAJORITY) return 'pepe';
  return null;
}

/** Ties break on the listed order, so the same counts always give the same emote. */
export function topEmoteFromCounts(counts: Record<string, number>): string | null {
  let best: string | null = null;
  for (const emote of DANCING_EMOTES) {
    if ((counts[emote] ?? 0) > (best === null ? 0 : counts[best] ?? 0)) best = emote;
  }
  return best;
}

async function countTerm(
  username: string,
  term: string,
  fetcher: typeof fetch,
): Promise<{ count: number; remaining: number | null }> {
  const endpoint = `${POLECAT_SEARCH}/${encodeURIComponent(username)}/${encodeURIComponent(term)}?count=true`;
  const response = await fetcher(endpoint, { signal: AbortSignal.timeout(8_000) });

  if (response.status === 429) {
    throw new ChatLookupError('CHAT_RATE_LIMITED', 'Chat search is busy. Try again shortly.', 429);
  }
  if (!response.ok) {
    throw new ChatLookupError('CHAT_LOOKUP_FAILED', 'Chat search did not answer.');
  }

  const result = countSchema.safeParse(await response.json());
  if (!result.success) {
    throw new ChatLookupError('CHAT_LOOKUP_FAILED', 'Chat search returned an unexpected answer.');
  }

  const header = response.headers.get('RateLimit-Remaining');
  return { count: result.data.count, remaining: header === null ? null : Number(header) };
}

/**
 * Eleven counts, one request each, in sequence so every response reports what
 * the last one spent. Stopping on an exhausted window beats waiting it out: the
 * check runs again another day, and half a set of counts would place someone on
 * the wrong side and give them the wrong emote.
 *
 * An unknown username answers zero rather than 404, so a typo reads as "says
 * nothing" instead of an error.
 */
export async function countChatTerms(
  username: string,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const term of COUNTED_TERMS) {
    const { count, remaining } = await countTerm(username, term, fetcher);
    counts[term] = count;
    if (remaining !== null && remaining < 1) {
      throw new ChatLookupError('CHAT_RATE_LIMITED', 'Chat search is busy. Try again shortly.', 429);
    }
  }
  return counts;
}

/**
 * Counts every term for one person and stores the lot: the raw numbers, so the
 * reasoning stays inspectable, and the two values read on every page.
 */
export async function refreshChatCounts(
  user: { id: string; username: string },
  fetcher: typeof fetch = fetch,
  db: Database = getDatabase(),
): Promise<{ team: Team; topEmote: string | null }> {
  const counts = await countChatTerms(user.username, fetcher);
  const team = teamFromCounts(counts.yee ?? 0, counts.pepe ?? 0);
  const topEmote = topEmoteFromCounts(counts);

  await db.transaction(async (transaction) => {
    await transaction.delete(userChatCounts).where(eq(userChatCounts.userId, user.id));
    await transaction.insert(userChatCounts).values(
      COUNTED_TERMS.map((term) => ({ userId: user.id, term, count: counts[term] ?? 0 })),
    );
    await transaction
      .update(users)
      .set({ team, topEmote, chatCheckedAt: new Date() })
      .where(eq(users.id, user.id));
  });

  return { team, topEmote };
}

/**
 * One check at a time, process wide. Each is eleven requests against a sixty a
 * minute allowance, so letting several run together is the one reliable way to
 * be rate limited.
 */
let running: Promise<unknown> = Promise.resolve();

export function enqueueChatCheck(
  user: { id: string; username: string },
  fetcher: typeof fetch = fetch,
  db: Database = getDatabase(),
): Promise<{ team: Team; topEmote: string | null }> {
  const next = running
    .catch(() => undefined)
    .then(() => refreshChatCounts(user, fetcher, db));
  running = next.catch(() => undefined);
  return next;
}

/** A day between voluntary checks, so one person cannot spend the whole allowance. */
export const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

/**
 * A check someone asked for themselves. The cooldown is enforced here rather
 * than in the interface, because a disabled button is a courtesy and not a
 * limit.
 */
export async function requestChatCheck(
  user: { id: string; username: string },
  fetcher: typeof fetch = fetch,
  db: Database = getDatabase(),
): Promise<{ team: Team; topEmote: string | null }> {
  const [row] = await db
    .select({ chatCheckedAt: users.chatCheckedAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const checkedAt = row?.chatCheckedAt;
  if (checkedAt && checkedAt.getTime() > Date.now() - CHECK_COOLDOWN_MS) {
    throw new ChatLookupError(
      'CHAT_CHECK_TOO_SOON',
      'Your chat was counted in the last day. Try again tomorrow.',
      429,
    );
  }

  return enqueueChatCheck(user, fetcher, db);
}

/** Every stored count for one person, for showing the working. */
export async function listChatCounts(
  userId: string,
  db: Database = getDatabase(),
): Promise<Record<string, number>> {
  const rows = await db
    .select({ term: userChatCounts.term, count: userChatCounts.count })
    .from(userChatCounts)
    .where(and(eq(userChatCounts.userId, userId), inArray(userChatCounts.term, [...COUNTED_TERMS])));
  return Object.fromEntries(rows.map(({ term, count }) => [term, count]));
}
