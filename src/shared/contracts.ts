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

/**
 * Blocking something nobody has requested. The link is read the way a request
 * is, so the same paste blocks one track or everything by whoever published it.
 */
export const blockByUrlSchema = z.object({
  url: z.string().trim().min(1).max(400),
  entryType: z.enum(['track', 'artist']),
  note: z.string().trim().max(240).optional(),
});

/** What blocking a link turned out to cover. */
export interface BlockByUrlResult {
  /** What went on the list, which is the track's title or the artist's name. */
  label: string;
  /** Requests already waiting that the new entry took out. */
  removed: number;
}

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

/**
 * How many tracks one personal playlist holds. It was 50 while nothing had
 * been tested against real use; importing a library from QueUp is that test,
 * and a playlist someone has kept for years is routinely longer than 50.
 */
export const MAX_PLAYLIST_TRACKS = 500;

/**
 * How many tracks one request may put in the queue, whether that is a provider
 * playlist or a saved one. Queueing walks every track through the room's own
 * checks, so this is really how long one request may run and how many provider
 * lookups it may spend. Storing a playlist is cheap; playing one is not, and
 * the two limits are separate for that reason.
 */
export const MAX_QUEUE_IMPORT_TRACKS = 50;

/**
 * How many tracks one import request resolves. A file may hold more; the rest
 * are reported rather than resolved, because one request that walks thousands
 * of tracks through the provider stops being a request and becomes a job with
 * progress to report.
 */
export const MAX_IMPORT_TRACKS = 1_000;

export const personalPlaylistSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/**
 * A file written by `public/queup-export-playlists.js`, read leniently on
 * purpose: a track QueUp recorded oddly should be reported by name in the
 * result, not turn the whole import into a validation error.
 */
export const queupImportSchema = z.object({
  source: z.literal('queup'),
  kind: z.literal('playlists'),
  playlists: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        tracks: z
          .array(
            z.object({
              provider: z.string(),
              providerMediaId: z.string().min(1).max(128),
              title: z.string().default(''),
            }),
          )
          .max(5_000),
      }),
    )
    .min(1)
    .max(50),
});

export interface QueupImportResult {
  playlists: Array<{
    name: string;
    /** False when the tracks went into a playlist of that name you already had. */
    created: boolean;
    attempted: number;
    saved: number;
    duplicates: number;
    skipped: { title: string; reason: string }[];
  }>;
}

export const playlistOrderSchema = z.object({
  orderedMediaIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_PLAYLIST_TRACKS)
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

export type GenreSource = 'musicbrainz' | 'discogs';
export type GenreLevel = 'recording' | 'release_group' | 'artist' | 'master';

/** What one source says a track is, kept in that source's own vocabulary. */
export interface TrackGenre {
  source: GenreSource;
  /**
   * What the genre describes. `artist` is coarse -- it is the artist's whole
   * catalogue, not this track -- and is labelled as such wherever it is shown.
   */
  level: GenreLevel;
  genres: string[];
  /** Discogs' sharper second vocabulary. Always empty for MusicBrainz. */
  styles: string[];
  /** Where a reader can check it. Both licences ask for the link. */
  url: string | null;
  /**
   * Discogs attached this video to several masters that disagreed. The answer
   * is still worth showing, but not as though it were settled.
   */
  ambiguous: boolean;
}

export interface TrackGenres {
  entries: TrackGenre[];
  /**
   * Two independent sources both labelled the track itself. It does not mean
   * they used the same words: their vocabularies are different by design and
   * are never normalised into each other.
   */
  corroborated: boolean;
  /** Nothing here describes the track, only whoever made it. */
  artistLevelOnly: boolean;
}

export interface RoomMedia {
  id: string;
  provider: MediaProvider;
  providerMediaId: string;
  /**
   * The channel on YouTube, the uploading account on SoundCloud. It is what an
   * artist page is keyed by, and what blocking an artist blocks.
   */
  providerArtistId: string;
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

/** What saving one archived play into a playlist did. */
export interface LegacySaveResult {
  /**
   * The row the archive entry resolved to. The page keeps it so the track stops
   * being an unresolved one and behaves like every other saved track.
   */
  mediaId: string;
  /** False when the track was already in that playlist. */
  saved: boolean;
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

/**
 * One track from the room's QueUp years, imported from an export of that site.
 * Deliberately not a `HistoryEntry`: there is no media row behind it, no
 * account behind the name, and the votes were cast somewhere else, so nothing
 * here can be queued, saved, or voted on.
 */
export interface LegacyPlay {
  /** QueUp's own id for the play, which is what the archive is keyed by. */
  id: string;
  provider: MediaProvider;
  /** The provider's id for the track, which the room's own pages are keyed by. */
  providerMediaId: string;
  title: string;
  /** The track's own page, when the provider's id makes a link on its own. */
  canonicalUrl: string | null;
  durationSeconds: number;
  thumbnailUrl: string | null;
  /**
   * The room's own row for this track, when one already exists. Null means the
   * archive holds a provider and an id and nothing else, so saving the track
   * has to ask the provider before it can go anywhere.
   */
  mediaId: string | null;
  /** What the track is, where anyone knows. Null is the ordinary answer. */
  genres: TrackGenres | null;
  /** Their QueUp name. Some of them are somebody's Destiny name too; most are guesses. */
  requesterName: string;
  playedAt: string;
  upvotes: number;
  downvotes: number;
  skipped: boolean;
}

export interface LegacyHistoryPage {
  entries: LegacyPlay[];
  /**
   * Every archived play the request matched, not just this page. It is what
   * says how many pages there are and how much a search found.
   */
  total: number;
}

export interface HistoryEntry {
  id: string;
  media: RoomMedia;
  /** What the track is, where anyone knows. Null is the ordinary answer. */
  genres: TrackGenres | null;
  requestedBy: RoomUser;
  status: 'playing' | 'played' | 'skipped';
  requestedAt: string;
  startedAt: string;
  finishedAt: string | null;
  upvotes: number;
  downvotes: number;
}

/**
 * How a history is being read. Both of them take the same four, which is why
 * one search box and one pager drive either.
 */
export interface HistoryQuery {
  limit?: number;
  page?: number;
  /** Matched against the track, the artist, and who requested it. */
  search?: string | null;
  /** One genre or style, exactly as a tag on a row spells it. */
  genre?: string | null;
}

/** The room's own history, paged and counted the same way the archive is. */
export interface HistoryPage {
  entries: HistoryEntry[];
  total: number;
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

/**
 * Which slice of time the stats are about. A month without a year means
 * nothing, so it is ignored rather than guessed at.
 */
export interface StatsPeriod {
  year: number | null;
  /** 1 to 12, and only meaningful alongside a year. */
  month: number | null;
}

/** A year the room has plays in, and which of its months have any. */
export interface AvailablePeriod {
  year: number;
  months: number[];
}

/** One genre, and how much of each history it accounts for. */
export interface GenreCount {
  genre: string;
  /** Plays in this room. */
  roomPlays: number;
  /** Plays on QueUp, before this room existed. */
  archivePlays: number;
  /**
   * Which vocabularies this name belongs to. Usually one: Discogs' fifteen
   * broad genres and MusicBrainz's hundreds are different lists, and a name
   * appearing in both is the exception rather than the rule.
   */
  sources: GenreSource[];
}

export interface GenreStats {
  genres: GenreCount[];
  /** How much of what the room knows about is labelled at all. */
  coverage: {
    labelledTracks: number;
    tracks: number;
  };
}

/**
 * One track as the QueUp archive remembers it. It cannot be a `TrackStats`:
 * there is no `media` row behind it, and the votes were cast on another site
 * and stored per play rather than per person.
 */
export interface LegacyTrackStats {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  plays: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

/** One requester, by their QueUp name. There is no account behind it. */
export interface LegacyJammerStats {
  requesterName: string;
  plays: number;
  upvotes: number;
  downvotes: number;
  score: number;
}

/** What the archive says, kept apart from what this room says. */
export interface LegacyStats {
  tracks: LegacyTrackStats[];
  jammers: LegacyJammerStats[];
  totals: {
    plays: number;
    tracks: number;
    people: number;
    /** When the archive starts, or null when there is no archive. */
    since: string | null;
  };
}

/** One play of a track, in either history. */
export interface TrackPlay {
  /** The account that requested it, or null for an archived QueUp name. */
  requester: RoomUser | null;
  requesterName: string;
  playedAt: string;
  upvotes: number;
  downvotes: number;
  status: 'played' | 'skipped';
}

/** Enough of a track to offer it in a list of other things to hear. */
export interface TrackSummary {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
  thumbnailUrl: string | null;
  /** Across both histories. */
  plays: number;
}

/** Everything the room knows about one track. */
export interface TrackDetail {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
  /** Null for a track only the archive remembers: QueUp never stored one. */
  artist: string | null;
  providerArtistId: string | null;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  /** The room's own row, when it has played here. */
  mediaId: string | null;
  genres: TrackGenres | null;
  totals: {
    roomPlays: number;
    archivePlays: number;
    upvotes: number;
    downvotes: number;
    firstPlayed: string | null;
    lastPlayed: string | null;
  };
  /** The most recent plays of it, newest first, each history on its own. */
  roomPlays: TrackPlay[];
  archivePlays: TrackPlay[];
  related: {
    /** Others from the same channel or account. Empty without a media row. */
    byArtist: TrackSummary[];
    /** Others sharing a genre, from either history. */
    byGenre: TrackSummary[];
  };
}

export interface ArtistTrack extends TrackSummary {
  roomPlays: number;
  archivePlays: number;
}

/** Everything the room has by one channel or account. */
export interface ArtistDetail {
  provider: MediaProvider;
  providerArtistId: string;
  name: string;
  totals: {
    tracks: number;
    roomPlays: number;
    archivePlays: number;
  };
  /** What their tracks are, by how many of them carry each name. */
  genres: { name: string; tracks: number }[];
  tracks: ArtistTrack[];
}

/** One play of a track, in either history. */
export interface TrackPlay {
  /** The account that requested it, or null for an archived QueUp name. */
  requester: RoomUser | null;
  requesterName: string;
  playedAt: string;
  upvotes: number;
  downvotes: number;
  status: 'played' | 'skipped';
}

/** Enough of a track to offer it in a list of other things to hear. */
export interface TrackSummary {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
  thumbnailUrl: string | null;
  /** Across both histories. */
  plays: number;
}

/** Everything the room knows about one track. */
export interface TrackDetail {
  provider: MediaProvider;
  providerMediaId: string;
  title: string;
  /** Null for a track only the archive remembers: QueUp never stored one. */
  artist: string | null;
  providerArtistId: string | null;
  canonicalUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  /** The room's own row, when it has played here. */
  mediaId: string | null;
  genres: TrackGenres | null;
  totals: {
    roomPlays: number;
    archivePlays: number;
    upvotes: number;
    downvotes: number;
    firstPlayed: string | null;
    lastPlayed: string | null;
  };
  /** The most recent plays of it, newest first, each history on its own. */
  roomPlays: TrackPlay[];
  archivePlays: TrackPlay[];
  related: {
    /** Others from the same channel or account. Empty without a media row. */
    byArtist: TrackSummary[];
    /** Others sharing a genre, from either history. */
    byGenre: TrackSummary[];
  };
}

export interface ArtistTrack extends TrackSummary {
  roomPlays: number;
  archivePlays: number;
}

/** Everything the room has by one channel or account. */
export interface ArtistDetail {
  provider: MediaProvider;
  providerArtistId: string;
  name: string;
  totals: {
    tracks: number;
    roomPlays: number;
    archivePlays: number;
  };
  /** What their tracks are, by how many of them carry each name. */
  genres: { name: string; tracks: number }[];
  tracks: ArtistTrack[];
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
  genres: GenreStats;
  /** The same two tables for the QueUp years, empty when nothing is imported. */
  legacy: LegacyStats;
  /** What was asked for, echoed back so a page can trust what it is showing. */
  period: StatsPeriod;
  /**
   * Every year and month either history has a play in, newest first. It ignores
   * the current filter: it is what the filter offers to choose from.
   */
  periods: AvailablePeriod[];
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

/**
 * One thing a mod or admin did, as the room recorded it at the time. Every
 * action names an actor; the rest depends on what was done, so a track, a
 * target and a reason are each there only when that action carried one.
 */
export interface ModerationEntry {
  id: string;
  actor: string;
  action: string;
  track: { title: string; artist: string } | null;
  /** The person the action was aimed at, for actions about somebody's queue. */
  target: string | null;
  reason: string | null;
  /** Whatever else the action recorded, for the ones a reason does not cover. */
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ModerationLog {
  capturedAt: string;
  /** Newest first. */
  entries: ModerationEntry[];
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
  /**
   * What the track playing now is. Null while nobody knows, which includes the
   * moments after a track starts and before the sources have been asked.
   */
  currentGenres: TrackGenres | null;
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
