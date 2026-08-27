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
  reason: z.string().trim().min(3).max(240),
});

export const removeQueueItemSchema = z.object({
  reason: z.string().trim().min(3).max(240),
});

export const roomSettingsSchema = z.object({
  maxDurationSeconds: z.number().int().min(60).max(1_800),
});

export type UserRole = 'listener' | 'admin';

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
  requestedBy: RoomUser;
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

export interface RoomSnapshot {
  serverTime: string;
  revision: number;
  listenerCount: number;
  settings: {
    maxDurationSeconds: number;
    targetCountry: 'AE';
  };
  me: RoomUser | null;
  current: QueueItem | null;
  queue: QueueItem[];
  selectorStats: SelectorStats[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
