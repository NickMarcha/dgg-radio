import {
  and,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
} from 'drizzle-orm';
import type {
  CommunityStats,
  HistoryEntry,
  RoomUser,
  SelectorStats,
  TeamStats,
  TrackStats,
  UserProfile,
} from '../shared/contracts';
import { getDatabase, type Database } from './db/client';
import { media, queueItems, users, votes } from './db/schema';

export class CommunityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'CommunityError';
  }
}

const upvoteCount = sql<number>`(
  select count(*) from ${votes}
  where ${votes.queueItemId} = ${queueItems.id} and ${votes.value} = 1
)`.mapWith(Number);

const downvoteCount = sql<number>`(
  select count(*) from ${votes}
  where ${votes.queueItemId} = ${queueItems.id} and ${votes.value} = -1
)`.mapWith(Number);

function historySelection() {
  return {
    id: queueItems.id,
    status: queueItems.status,
    requestedAt: queueItems.requestedAt,
    startedAt: queueItems.startedAt,
    finishedAt: queueItems.finishedAt,
    mediaId: media.id,
    provider: media.provider,
    providerMediaId: media.providerMediaId,
    canonicalUrl: media.canonicalUrl,
    title: media.title,
    artist: media.artist,
    durationSeconds: media.durationSeconds,
    thumbnailUrl: media.thumbnailUrl,
    requesterId: users.id,
    requesterUsername: users.username,
    requesterAvatarUrl: users.avatarUrl,
    requesterRole: users.role,
    requesterTeam: users.team,
    requesterFlair: users.flair,
    requesterTopEmote: users.topEmote,
    upvotes: upvoteCount,
    downvotes: downvoteCount,
  };
}

type HistoryRow = {
  id: string;
  status: 'queued' | 'playing' | 'played' | 'skipped' | 'removed';
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  mediaId: string;
  provider: 'youtube' | 'soundcloud';
  providerMediaId: string;
  canonicalUrl: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  requesterId: string;
  requesterUsername: string;
  requesterAvatarUrl: string | null;
  requesterRole: 'listener' | 'mod' | 'admin';
  requesterTeam: 'pepe' | 'yee' | null;
  requesterFlair: string | null;
  requesterTopEmote: string | null;
  upvotes: number;
  downvotes: number;
};

function toHistoryEntry(row: HistoryRow): HistoryEntry {
  if (!row.startedAt || !['playing', 'played', 'skipped'].includes(row.status)) {
    throw new Error('A history row must have started playback.');
  }
  return {
    id: row.id,
    media: {
      id: row.mediaId,
      provider: row.provider,
      providerMediaId: row.providerMediaId,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      artist: row.artist,
      durationSeconds: row.durationSeconds,
      thumbnailUrl: row.thumbnailUrl,
    },
    requestedBy: {
      id: row.requesterId,
      username: row.requesterUsername,
      avatarUrl: row.requesterAvatarUrl,
      role: row.requesterRole,
      team: row.requesterTeam,
      flair: row.requesterFlair,
      topEmote: row.requesterTopEmote,
    },
    status: row.status as HistoryEntry['status'],
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
  };
}

export async function listHistory(
  limit = 50,
  db: Database = getDatabase(),
): Promise<HistoryEntry[]> {
  const rows = await db
    .select(historySelection())
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .where(inArray(queueItems.status, ['played', 'skipped']))
    .orderBy(desc(queueItems.finishedAt), desc(queueItems.startedAt))
    .limit(limit);
  return rows.map((row) => toHistoryEntry(row as HistoryRow));
}

export async function listJammers(
  limit = 100,
  db: Database = getDatabase(),
): Promise<SelectorStats[]> {
  const scoreExpression = sql<number>`coalesce(sum(${votes.value}), 0)`.mapWith(Number);
  const rows = await db
    .select({
      userId: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      team: users.team,
      flair: users.flair,
      topEmote: users.topEmote,
      plays: countDistinct(queueItems.id).mapWith(Number),
      upvotes: sql<number>`count(*) filter (where ${votes.value} = 1)`.mapWith(Number),
      downvotes: sql<number>`count(*) filter (where ${votes.value} = -1)`.mapWith(Number),
      score: scoreExpression,
    })
    .from(queueItems)
    .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
    .leftJoin(votes, eq(queueItems.id, votes.queueItemId))
    .where(isNotNull(queueItems.startedAt))
    .groupBy(users.id, users.username, users.avatarUrl, users.role, users.team, users.flair, users.topEmote)
    .orderBy(desc(scoreExpression), desc(countDistinct(queueItems.id)))
    .limit(limit);

  return rows.map((row) => ({
    user: {
      id: row.userId,
      username: row.username,
      avatarUrl: row.avatarUrl,
      role: row.role,
      flair: row.flair,
      topEmote: row.topEmote,
      team: row.team,
    },
    plays: row.plays,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    score: row.score,
  }));
}

/**
 * The tracks the room has actually reached, most played first. A play is a
 * queue item that started, so a track skipped part-way still counts as one:
 * the room heard it and voted on it.
 */
export async function listTopTracks(
  limit = 100,
  db: Database = getDatabase(),
): Promise<TrackStats[]> {
  const playExpression = countDistinct(queueItems.id).mapWith(Number);
  const scoreExpression = sql<number>`coalesce(sum(${votes.value}), 0)`.mapWith(Number);
  const rows = await db
    .select({
      id: media.id,
      provider: media.provider,
      providerMediaId: media.providerMediaId,
      canonicalUrl: media.canonicalUrl,
      title: media.title,
      artist: media.artist,
      durationSeconds: media.durationSeconds,
      thumbnailUrl: media.thumbnailUrl,
      plays: playExpression,
      upvotes: sql<number>`count(*) filter (where ${votes.value} = 1)`.mapWith(Number),
      downvotes: sql<number>`count(*) filter (where ${votes.value} = -1)`.mapWith(Number),
      score: scoreExpression,
    })
    .from(queueItems)
    .innerJoin(media, eq(queueItems.mediaId, media.id))
    .leftJoin(votes, eq(queueItems.id, votes.queueItemId))
    .where(isNotNull(queueItems.startedAt))
    .groupBy(media.id)
    .orderBy(desc(playExpression), desc(scoreExpression))
    .limit(limit);

  return rows.map(({ plays, upvotes, downvotes, score, ...media }) => ({
    media,
    plays,
    upvotes,
    downvotes,
    score,
  }));
}

async function teamStats(db: Database): Promise<TeamStats[]> {
  const scoreExpression = sql<number>`coalesce(sum(${votes.value}), 0)`.mapWith(Number);
  const rows = await db
    .select({
      team: users.team,
      members: countDistinct(users.id).mapWith(Number),
      plays: countDistinct(queueItems.id).mapWith(Number),
      upvotes: sql<number>`count(*) filter (where ${votes.value} = 1)`.mapWith(Number),
      downvotes: sql<number>`count(*) filter (where ${votes.value} = -1)`.mapWith(Number),
      score: scoreExpression,
    })
    .from(users)
    .leftJoin(
      queueItems,
      and(eq(queueItems.requestedByUserId, users.id), isNotNull(queueItems.startedAt)),
    )
    .leftJoin(votes, eq(votes.queueItemId, queueItems.id))
    .groupBy(users.team);

  const byTeam = new Map(rows.map((row) => [row.team ?? 'unassigned', row]));
  return (['pepe', 'yee', 'unassigned'] as const).map((team) => {
    const row = byTeam.get(team);
    return {
      team,
      members: row?.members ?? 0,
      plays: row?.plays ?? 0,
      upvotes: row?.upvotes ?? 0,
      downvotes: row?.downvotes ?? 0,
      score: row?.score ?? 0,
    };
  });
}

export async function getCommunityStats(
  db: Database = getDatabase(),
): Promise<CommunityStats> {
  const [jammers, teams, tracks] = await Promise.all([
    listJammers(100, db),
    teamStats(db),
    listTopTracks(100, db),
  ]);
  return {
    totals: {
      members: teams.reduce((total, team) => total + team.members, 0),
      tracksPlayed: teams.reduce((total, team) => total + team.plays, 0),
      votes: teams.reduce((total, team) => total + team.upvotes + team.downvotes, 0),
    },
    jammers,
    teams,
    tracks,
  };
}

export async function getUserProfile(
  username: string,
  viewerId: string | null = null,
  db: Database = getDatabase(),
): Promise<UserProfile> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      role: users.role,
      team: users.team,
      flair: users.flair,
      topEmote: users.topEmote,
      joinedAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      chatCheckedAt: users.chatCheckedAt,
    })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);

  if (!user) {
    throw new CommunityError('PROFILE_NOT_FOUND', 'No listener has used that username.', 404);
  }

  const [summaryRows, historyRows] = await Promise.all([
    db
      .select({
        requests: countDistinct(queueItems.id).mapWith(Number),
        plays: sql<number>`count(distinct ${queueItems.id}) filter (where ${queueItems.startedAt} is not null)`.mapWith(Number),
        played: sql<number>`count(distinct ${queueItems.id}) filter (where ${queueItems.status} = 'played')`.mapWith(Number),
        skipped: sql<number>`count(distinct ${queueItems.id}) filter (where ${queueItems.status} = 'skipped')`.mapWith(Number),
        upvotes: sql<number>`count(*) filter (where ${votes.value} = 1)`.mapWith(Number),
        downvotes: sql<number>`count(*) filter (where ${votes.value} = -1)`.mapWith(Number),
        score: sql<number>`coalesce(sum(${votes.value}), 0)`.mapWith(Number),
      })
      .from(queueItems)
      .leftJoin(votes, eq(votes.queueItemId, queueItems.id))
      .where(eq(queueItems.requestedByUserId, user.id))
      .then(([row]) => row),
    db
      .select(historySelection())
      .from(queueItems)
      .innerJoin(media, eq(queueItems.mediaId, media.id))
      .innerJoin(users, eq(queueItems.requestedByUserId, users.id))
      .where(and(eq(queueItems.requestedByUserId, user.id), isNotNull(queueItems.startedAt)))
      .orderBy(desc(queueItems.startedAt))
      .limit(100),
  ]);

  const summary = summaryRows ?? {
    requests: 0,
    plays: 0,
    played: 0,
    skipped: 0,
    upvotes: 0,
    downvotes: 0,
    score: 0,
  };
  const voteCount = summary.upvotes + summary.downvotes;

  const roomUser: RoomUser = {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    role: user.role,
    team: user.team,
    flair: user.flair,
    topEmote: user.topEmote,
  };

  return {
    user: roomUser,
    joinedAt: user.joinedAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
    isSelf: viewerId === user.id,
    chatCheckedAt: user.chatCheckedAt?.toISOString() ?? null,
    stats: {
      ...summary,
      averageVotesPerPlay: summary.plays > 0 ? voteCount / summary.plays : 0,
      averageScorePerPlay: summary.plays > 0 ? summary.score / summary.plays : 0,
    },
    history: historyRows.map((row) => toHistoryEntry(row as HistoryRow)),
  };
}
