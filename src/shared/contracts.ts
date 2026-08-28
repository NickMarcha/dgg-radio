import { z } from 'zod';

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

export interface RoomUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  role: UserRole;
  team: 'pepe' | 'yee' | null;
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

export interface CommunityStats {
  totals: {
    members: number;
    tracksPlayed: number;
    votes: number;
  };
  jammers: SelectorStats[];
  teams: TeamStats[];
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
  team: 'pepe' | 'yee' | null;
  /** Named in the environment, so always an admin and not removable here. */
  isRoot: boolean;
  queuedCount: number;
  lastSeenAt: string;
}

export interface RoomSnapshot {
  serverTime: string;
  revision: number;
  listenerCount: number;
  settings: {
    description: string;
    maxDurationSeconds: number;
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
