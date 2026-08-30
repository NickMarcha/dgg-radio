import { z } from 'zod';
import type { ConnectionKind } from './roomConnection';

export const mediaProviderSchema = z.enum(['youtube', 'soundcloud']);
export type MediaProvider = z.infer<typeof mediaProviderSchema>;

export const submitRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/, hostname: z.regexes.domain }),
});

export const voteSchema = z.object({
  value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
});

export const blockMediaSchema = z.object({
  /** One track can break several rules, and the room shows every reason. */
  ruleIds: z.array(z.uuid()).min(1).max(10),
  entryType: z.enum(['track', 'artist']),
  note: z.string().trim().max(240).optional(),
});

export const ruleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(600).default(''),
  enforcement: z.enum(['blocklist', 'advisory']),
});

export const ruleUpdateSchema = ruleSchema.partial().extend({
  active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export const searchSchema = z.object({
  q: z.string().trim().min(2).max(120),
});

export const playlistSchema = z.object({
  url: z.url(),
});

/**
 * True for a link that names a playlist or set, even when it also names one
 * track inside it. A `watch?v=...&list=...` link therefore means the whole
 * playlist. Both the request box and the playlist library route on this, so it
 * lives here rather than being decided twice.
 */
export function isPlaylistUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.searchParams.has('list') || url.pathname.toLowerCase().includes('/sets/');
  } catch {
    return false;
  }
}

export const personalPlaylistSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const playlistOrderSchema = z.object({
  orderedMediaIds: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Media IDs must be unique.'),
});

export const playlistListQuerySchema = z.object({
  mediaIds: z.preprocess(
    (value) =>
      typeof value === 'string' && value.length > 0
        ? value.split(',')
        : [],
    // Above the history page's own limit, so a full page of rows still fits.
    z.array(z.uuid()).max(200),
  ),
});

export interface SearchResult {
  provider: MediaProvider;
  url: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

/** Shared by the queue and rule reorder routes: the full list, in its new order. */
export const reorderSchema = z.object({
  orderedIds: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'Ids must be unique.'),
});

export const clearQueueSchema = z.object({
  reason: z.string().trim().min(3).max(240),
});

export const userRoleSchema = z.object({
  role: z.enum(['listener', 'mod', 'admin']),
});

export const removeQueueItemSchema = z.object({
  reason: z.string().trim().min(3).max(240),
});

export const roomSettingsSchema = z.object({
  description: z.string().trim().max(4_000).optional(),
  maxDurationSeconds: z.number().int().min(60).max(1_800).optional(),
  repeatCooldownSeconds: z.number().int().min(300).max(2_592_000).optional(),
  targetCountry: z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code.').optional(),
  skipMode: z.enum(['absolute', 'ratio']).optional(),
  skipDownvotes: z.number().int().min(1).max(500).optional(),
  skipRatioPercent: z.number().int().min(1).max(100).optional(),
  revealRequester: z.boolean().optional(),
});

/** A country YouTube will run its availability checks against. */
export interface PlaybackRegion {
  code: string;
  name: string;
}

export type UserRole = 'listener' | 'mod' | 'admin';

/** Stands in wherever someone has no counted emote of their own. Never counted itself. */
export const DEFAULT_EMOTE = 'MMMM';

/** Which side of the room someone falls on, or none when their chat is mixed. */
export type Team = 'pepe' | 'yee' | null;

export interface RoomUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  role: UserRole;
  team: Team;
  /** The Destiny flair their username is coloured after, or null when none colours it. */
  flair: string | null;
  /** Their most used dancing emote, or null until their chat has been counted. */
  topEmote: string | null;
}

export interface RoomMedia {
  id: string;
  provider: MediaProvider;
  providerMediaId: string;
  canonicalUrl: string;
  title: string;
  artist: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  updatedAt: string;
}

export interface PlaylistTrack {
  media: RoomMedia;
  position: number;
  addedAt: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: PlaylistTrack[];
}

export interface PlaylistLibrary {
  playlists: PlaylistSummary[];
  memberships: Record<string, string[]>;
}

export interface PlaylistSaveResult {
  attempted: number;
  saved: number;
  /** Tracks already in the playlist. Saving them again changed nothing. */
  duplicates: number;
  skipped: { title: string; reason: string }[];
}

export interface PlaylistQueueResult {
  attempted: number;
  added: number;
  skipped: Array<{
    mediaId: string;
    title: string;
    code: string;
    reason: string;
  }>;
}

export interface QueueItem {
  id: string;
  media: RoomMedia;
  /** Null when the room is hiding requesters and the viewer may not see it. */
  requestedBy: RoomUser | null;
  status: 'queued' | 'playing' | 'played' | 'skipped' | 'removed';
  requestedAt: string;
  startedAt: string | null;
  upvotes: number;
  downvotes: number;
  myVote: -1 | 0 | 1;
}

export interface SelectorStats {
  user: RoomUser;
  plays: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface HistoryEntry {
  id: string;
  media: RoomMedia;
  requestedBy: RoomUser;
  status: 'playing' | 'played' | 'skipped';
  requestedAt: string;
  startedAt: string;
  finishedAt: string | null;
  upvotes: number;
  downvotes: number;
}

export interface UserProfile {
  user: RoomUser;
  joinedAt: string;
  lastSeenAt: string;
  /** True when the signed-in viewer is looking at their own profile. */
  isSelf: boolean;
  /** When their chat was last counted, or null if it never has been. */
  chatCheckedAt: string | null;
  stats: {
    requests: number;
    plays: number;
    played: number;
    skipped: number;
    upvotes: number;
    downvotes: number;
    score: number;
    averageVotesPerPlay: number;
    averageScorePerPlay: number;
  };
  history: HistoryEntry[];
}

export interface TeamStats {
  team: 'pepe' | 'yee' | 'unassigned';
  members: number;
  plays: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

/** One track and how the room has received it across every play. */
export interface TrackStats {
  media: RoomMedia;
  plays: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

export interface CommunityStats {
  totals: {
    members: number;
    tracksPlayed: number;
    votes: number;
  };
  jammers: SelectorStats[];
  teams: TeamStats[];
  tracks: TrackStats[];
}

export type RuleEnforcement = 'blocklist' | 'advisory';
export type RuleEntryType = 'track' | 'artist';

export interface RuleSummary {
  id: string;
  name: string;
  description: string;
  enforcement: RuleEnforcement;
  active: boolean;
  position: number;
  entryCount: number;
}

/** The shape listeners see: no counts, no inactive rules. */
export interface PublicRule {
  id: string;
  name: string;
  description: string;
  enforcement: RuleEnforcement;
}

export interface RuleEntrySummary {
  id: string;
  ruleId: string;
  provider: MediaProvider;
  entryType: RuleEntryType;
  providerId: string;
  label: string;
  note: string | null;
  createdAt: string;
}

export interface RoomMember {
  id: string;
  username: string;
  avatarUrl: string | null;
  role: UserRole;
  team: Team;
  /** Named in the environment, so always an admin and not removable here. */
  isRoot: boolean;
  queuedCount: number;
  lastSeenAt: string;
}

export interface ActiveConnection {
  kind: ConnectionKind;
  username: string | null;
  connectedAt: string;
}

export interface ConnectionSnapshot {
  socketCount: number;
  listenerCount: number;
  eligibleVoterCount: number;
  connections: ActiveConnection[];
}

export interface StorageGroup {
  name: string;
  /** The tables the group measures, so an admin can see what it covers. */
  tables: string[];
  rowCount: number;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  /** Share of `databaseBytes`, between 0 and 1. */
  share: number;
}

/**
 * What PostgreSQL reports about its own tables and indexes. Nothing else on the
 * volume is in these numbers: the write-ahead log, PostgreSQL's fixed files and
 * container logs all sit outside them, and there is no backup job behind them.
 */
export interface StorageSnapshot {
  databaseBytes: number;
  /** Largest group first. */
  groups: StorageGroup[];
}

/** What the API process knows about itself without asking the database. */
export interface ProcessSnapshot extends ConnectionSnapshot {
  capturedAt: string;
  processStartedAt: string;
  clock: {
    checks: number;
    advances: number;
    lastCheckedAt: string | null;
    lastAdvancedAt: string | null;
  };
}

export interface OperationsSnapshot extends ProcessSnapshot {
  storage: StorageSnapshot;
}

/**
 * What a page header needs: who is signed in, and how many people are
 * listening. Every page shows this, and only the room itself needs the whole
 * snapshot behind it.
 */
export interface SessionSnapshot {
  me: RoomUser | null;
  listenerCount: number;
}

/**
 * Something the room did to one person's request while they were not watching.
 * The room writes the text itself, so a moderator's private note never reaches
 * the person it is about.
 */
export interface QueueNotice {
  queueItemId: string;
  title: string;
  artist: string;
  message: string;
  removedAt: string;
}

export interface RoomSnapshot {
  serverTime: string;
  revision: number;
  listenerCount: number;
  settings: {
    description: string;
    maxDurationSeconds: number;
    repeatCooldownSeconds: number;
    targetCountry: string;
    skipMode: 'absolute' | 'ratio';
    skipDownvotes: number;
    skipRatioPercent: number;
    revealRequester: boolean;
  };
  me: RoomUser | null;
  current: QueueItem | null;
  /** One track per person waiting, in the order the room will reach them. */
  queue: QueueItem[];
  /** Everything the signed-in user has waiting, in their own order. */
  myQueue: QueueItem[];
  /** Unread explanations for the signed-in user's own requests, newest first. */
  myNotices: QueueNotice[];
  /** Active rules, in the order admins arranged them. */
  rules: PublicRule[];
  selectorStats: SelectorStats[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
