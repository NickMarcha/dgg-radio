import { sql } from 'drizzle-orm';
import type { MediaMetadata, RegionRestriction } from '../media';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** A site-wide role. Moderating a station is a station role, kept in `station_members`. */
export const userRole = pgEnum('user_role', ['listener', 'admin']);
export const stationRole = pgEnum('station_role', ['owner', 'mod']);
export const userTeam = pgEnum('user_team', ['pepe', 'yee']);
export const mediaProvider = pgEnum('media_provider', ['youtube', 'soundcloud']);
/**
 * Positions in the DJ rotation. Joining the rotation or being sent to the back
 * both take the next value, so ascending order is the play order.
 */
export const djRotation = pgSequence('dj_rotation_seq');

/** Where a genre came from. The two vocabularies are never merged, so both stay named. */
export const genreSource = pgEnum('genre_source', ['musicbrainz', 'discogs']);
/**
 * What the genre actually describes. `artist` is the coarse one: every Boards of
 * Canada track inherits the same genres regardless of which track played, so it
 * is worth having and must never be shown as though it described the track.
 */
export const genreLevel = pgEnum('genre_level', [
  'recording',
  'release_group',
  'artist',
  'master',
]);

export const ruleEnforcement = pgEnum('rule_enforcement', ['blocklist', 'advisory']);
export const ruleEntryType = pgEnum('rule_entry_type', ['track', 'artist']);
export const skipMode = pgEnum('skip_mode', ['absolute', 'ratio']);

/** The platforms destiny.gg embeds, as they are spelled in a chatter's `watching`. */
export const watchPlatform = pgEnum('watch_platform', [
  'kick',
  'youtube',
  'twitch',
  'angelthump',
]);
export const watcherShow = pgEnum('watcher_show', ['speakers', 'all', 'members']);
export const watcherLayout = pgEnum('watcher_layout', [
  'float',
  'safe',
  'rail',
  'column',
  'sides',
  'climb',
  'bump',
]);
export const watcherMotion = pgEnum('watcher_motion', ['drift', 'bob', 'orbit', 'sway']);
export const watcherColor = pgEnum('watcher_color', ['flair', 'white']);
export const watcherNames = pgEnum('watcher_names', ['under', 'beside', 'off']);
export const watcherEntrance = pgEnum('watcher_entrance', [
  'fade',
  'spin',
  'slide',
  'random',
]);
export const queueStatus = pgEnum('queue_status', [
  'queued',
  'playing',
  'played',
  'skipped',
  'removed',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dggUserId: text('dgg_user_id').notNull(),
    username: text('username').notNull(),
    avatarUrl: text('avatar_url'),
    role: userRole('role').notNull().default('listener'),
    /** Whitelisted by a site admin to create a station of their own. */
    canCreateStations: boolean('can_create_stations').notNull().default(false),
    team: userTeam('team'),
    /** The Destiny flair their username takes its colour from, or null for no colour. */
    flair: text('flair'),
    /** Their most used dancing emote, shown wherever an avatar is. */
    topEmote: text('top_emote'),
    /** When chat was last counted for this user. Null means never, which is what schedules the first check. */
    chatCheckedAt: timestamp('chat_checked_at', { withTimezone: true }),
    dggStatus: text('dgg_status').notNull(),
    dggRoles: text('dgg_roles').array().notNull().default(sql`'{}'::text[]`),
    dggFeatures: text('dgg_features').array().notNull().default(sql`'{}'::text[]`),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_dgg_user_id_unique').on(table.dggUserId),
    index('users_username_lower_index').on(sql`lower(${table.username})`),
  ],
);

export const oauthLoginTransactions = pgTable(
  'oauth_login_transactions',
  {
    stateHash: text('state_hash').primaryKey(),
    codeVerifier: text('code_verifier').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('oauth_login_expires_at_index').on(table.expiresAt)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_index').on(table.userId),
    index('sessions_expires_at_index').on(table.expiresAt),
  ],
);

export const media = pgTable(
  'media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: mediaProvider('provider').notNull(),
    providerMediaId: text('provider_media_id').notNull(),
    providerArtistId: text('provider_artist_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title').notNull(),
    artist: text('artist').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_provider_id_unique').on(table.provider, table.providerMediaId),
    check('media_duration_positive', sql`${table.durationSeconds} > 0`),
  ],
);

export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('playlists_owner_name_lower_unique').on(
      table.ownerUserId,
      sql`lower(${table.name})`,
    ),
    index('playlists_owner_updated_index').on(table.ownerUserId, table.updatedAt),
  ],
);

export const playlistItems = pgTable(
  'playlist_items',
  {
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id),
    position: integer('position').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.mediaId] }),
    index('playlist_items_position_index').on(table.playlistId, table.position),
    check('playlist_items_position_non_negative', sql`${table.position} >= 0`),
  ],
);

/**
 * Provider lookups cost something every time: YouTube bills quota, and
 * SoundCloud answers come from an unofficial endpoint worth asking sparingly.
 * This holds the last answer per track, whether or not the station could play it,
 * so a submission and the check just before playback do not both cost, and so
 * a track the station keeps refusing is asked about once rather than once per
 * attempt. Rows are overwritten in place, never deleted, so a re-check that
 * fails leaves the previous answer visible.
 *
 * `media-cache.ts` owns how long a row stands.
 */
export const mediaLookups = pgTable('media_lookups', {
  key: text('key').primaryKey(),
  provider: mediaProvider('provider').notNull(),
  metadata: jsonb('metadata').$type<MediaMetadata>().notNull(),
  /**
   * Why the station could not play the track when it was asked, or null when it
   * could. Stored so a repeat question is answered from here rather than from
   * the provider, and so a cached answer cannot let a refused track through.
   */
  playbackIssueCode: text('playback_issue_code'),
  playbackIssueMessage: text('playback_issue_message'),
  /**
   * The countries YouTube allowed or blocked, kept as it gave them. The region
   * verdict is worked out from this on every read, so moving the station's
   * playback region needs no new lookups.
   */
  regionRestriction: jsonb('region_restriction').$type<RegionRestriction>(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every term counted for one person in Destiny chat, kept raw rather than only
 * as the team and emote derived from them, so a surprising result can be read
 * back rather than guessed at. Rewritten wholesale on each check.
 */
export const userChatCounts = pgTable(
  'user_chat_counts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    term: text('term').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.term] })],
);

/**
 * YouTube's i18nRegions answer, kept so the admin panel does not ask for it on
 * every visit. The whole list is rewritten at once, so every row shares a
 * fetched_at and any one of them dates the cache.
 */
export const playbackRegions = pgTable('playback_regions', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A station: its own queue, settings, rules, and stream. The main station is the one
 * at `/`, and its id is fixed (`MAIN_STATION_ID` in `stations.ts`) so the code can
 * name it without a lookup. Every other station is created later and gets a random
 * id.
 */
export const stations = pgTable(
  'stations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The station's name in its URL, lowercase. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('stations_slug_unique').on(table.slug),
    check('stations_slug_shape', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,31}$'`),
  ],
);

export const queueItems = pgTable(
  'queue_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    stationId: uuid('station_id')
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    status: queueStatus('status').notNull().default('queued'),
    /** Order within the requester's own queue. Only meaningful while queued. */
    position: integer('position').notNull().default(0),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    moderationReason: text('moderation_reason'),
    /**
     * What the station owes the requester an explanation for, written for them to
     * read. `moderationReason` is the internal log and can hold a moderator's
     * private note, so the two must never be the same column. Cleared once the
     * requester has seen it.
     */
    listenerNotice: text('listener_notice'),
  },
  (table) => [
    index('queue_items_status_requested_index').on(table.status, table.requestedAt),
    index('queue_items_station_status_index').on(table.stationId, table.status),
    index('queue_items_requester_notice_index')
      .on(table.requestedByUserId)
      .where(sql`${table.listenerNotice} is not null`),
    index('queue_items_requester_status_index').on(
      table.requestedByUserId,
      table.status,
      table.position,
    ),
    uniqueIndex('queue_items_one_playing_unique')
      .on(table.stationId)
      .where(sql`${table.status} = 'playing'`),
  ],
);

/**
 * A seat in one station's DJ rotation, held while the user has something queued
 * there. Keyed by user, so a listener queues in one station at a time. Lower `seq`
 * plays sooner; taking the back of the rotation is taking a fresh number.
 */
export const stationSeats = pgTable(
  'station_seats',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    stationId: uuid('station_id')
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('dj_rotation_seq')`),
  },
  (table) => [index('station_seats_station_seq_index').on(table.stationId, table.seq)],
);

export const votes = pgTable(
  'votes',
  {
    queueItemId: uuid('queue_item_id')
      .notNull()
      .references(() => queueItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    value: integer('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.queueItemId, table.userId] }),
    check('votes_value_check', sql`${table.value} in (-1, 1)`),
  ],
);

/**
 * A rule is a named reason a mod or admin can act on. Some are enforced by matching a
 * growing list of tracks and artists, others exist only to be read by listeners.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The station that keeps this rule and whose moderators edit its list. */
    stationId: uuid('station_id')
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enforcement: ruleEnforcement('enforcement').notNull(),
    /** Off keeps the rule and its list, but stops showing and enforcing it. */
    active: boolean('active').notNull().default(true),
    position: integer('position').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rules_station_name_lower_unique').on(table.stationId, sql`lower(${table.name})`),
  ],
);

/**
 * One blocked track or artist, attributed to a rule it broke. The same track can
 * be listed under several rules, because one track can break several: the station
 * shows every reason rather than picking one. Blocking an artist covers their
 * whole catalogue; a collaboration released under someone else's channel needs
 * its own track entry.
 */
export const ruleEntries = pgTable(
  'rule_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    provider: mediaProvider('provider').notNull(),
    entryType: ruleEntryType('entry_type').notNull(),
    providerId: text('provider_id').notNull(),
    label: text('label').notNull(),
    note: text('note'),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One entry per rule per target: blocking the same track under the same rule
    // twice is a no-op, but a second rule gets its own row.
    uniqueIndex('rule_entries_target_unique').on(
      table.ruleId,
      table.provider,
      table.entryType,
      table.providerId,
    ),
    index('rule_entries_target_index').on(table.provider, table.entryType, table.providerId),
    index('rule_entries_rule_index').on(table.ruleId),
  ],
);

/**
 * Who runs a station. An owner manages the station and picks its moderators; a mod
 * moderates it. Site admins act in every station without a row here.
 */
export const stationMembers = pgTable(
  'station_members',
  {
    stationId: uuid('station_id')
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: stationRole('role').notNull(),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.stationId, table.userId] }),
    index('station_members_user_index').on(table.userId),
  ],
);

/**
 * A station enforcing a rule another station keeps. The rule stays the home
 * station's: the follower reads its list as it grows and cannot edit it.
 */
export const ruleFollows = pgTable(
  'rule_follows',
  {
    stationId: uuid('station_id')
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.stationId, table.ruleId] }),
    index('rule_follows_rule_index').on(table.ruleId),
  ],
);

/**
 * Edit access on one rule for someone outside its home station: either one
 * person, or a whole station whose owner and mods may then all edit it.
 */
export const ruleEditors = pgTable(
  'rule_editors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    stationId: uuid('station_id').references(() => stations.id, { onDelete: 'cascade' }),
    addedByUserId: uuid('added_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('rule_editors_one_grantee', sql`num_nonnulls(${table.userId}, ${table.stationId}) = 1`),
    uniqueIndex('rule_editors_rule_user_unique')
      .on(table.ruleId, table.userId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex('rule_editors_rule_station_unique')
      .on(table.ruleId, table.stationId)
      .where(sql`${table.stationId} is not null`),
  ],
);

export const ruleChangeAction = pgEnum('rule_change_action', ['add', 'remove']);

/**
 * Every entry added to or removed from a rule's list, with who did it, so a
 * change that reaches other stations through a followed rule can be undone.
 * The entry's own fields are copied here, because undoing a removal has to
 * put back an entry that no longer exists.
 */
export const ruleChanges = pgTable(
  'rule_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    action: ruleChangeAction('action').notNull(),
    provider: mediaProvider('provider').notNull(),
    entryType: ruleEntryType('entry_type').notNull(),
    providerId: text('provider_id').notNull(),
    label: text('label').notNull(),
    note: text('note'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedByUserId: uuid('reverted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('rule_changes_rule_created_index').on(table.ruleId, table.createdAt)],
);

export const stationSettings = pgTable(
  'station_settings',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => stations.id, { onDelete: 'cascade' }),
    /** Free text shown on the player: what this station is and how to behave. */
    description: text('description').notNull().default(''),
    maxDurationSeconds: integer('max_duration_seconds').notNull().default(420),
    repeatCooldownSeconds: integer('repeat_cooldown_seconds').notNull().default(5_400),
    targetCountry: text('target_country').notNull().default('AE'),
    skipMode: skipMode('skip_mode').notNull().default('absolute'),
    /** Downvotes needed to skip when skipMode is 'absolute'. */
    skipDownvotes: integer('skip_downvotes').notNull().default(5),
    /** Percentage of current listeners needed when skipMode is 'ratio'. */
    skipRatioPercent: integer('skip_ratio_percent').notNull().default(50),
    /** When false, requesters are hidden from listeners until a track ends. */
    revealRequester: boolean('reveal_requester').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
  },
  (table) => [
    check(
      'station_settings_duration_range',
      sql`${table.maxDurationSeconds} between 60 and 1800`,
    ),
    check(
      'station_settings_repeat_cooldown_range',
      sql`${table.repeatCooldownSeconds} between 300 and 2592000`,
    ),
    // The region is admin-editable now, so only its shape is enforced.
    check('station_settings_country_code', sql`${table.targetCountry} ~ '^[A-Z]{2}$'`),
    check('station_settings_skip_downvotes', sql`${table.skipDownvotes} >= 1`),
    check('station_settings_skip_ratio', sql`${table.skipRatioPercent} between 1 and 100`),
  ],
);

/**
 * Which stream a station watches on destiny.gg/bigscreen, so the overlay and the
 * admin page know whose watchers to count. One row per station.
 *
 * The channel is stored lowercase because that is how Destiny chat reports it
 * in `watching`, while the bigscreen link is written `#kick/dggJams`.
 */
export const streamWatch = pgTable(
  'stream_watch',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => stations.id, { onDelete: 'cascade' }),
    /** Whether one channel's chat roster is read, which is what the overlay draws. */
    enabled: boolean('enabled').notNull().default(false),
    platform: watchPlatform('platform').notNull().default('kick'),
    channel: text('channel').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
  },
  (table) => [
    check('stream_watch_channel_lowercase', sql`${table.channel} = lower(${table.channel})`),
  ],
);

/**
 * One stable watcher source per admin account. The public OBS URL uses the
 * owner's random UUID, while only that signed-in admin can change the row.
 */
export const watcherEmbedSettings = pgTable(
  'watcher_embed_settings',
  {
    ownerUserId: uuid('owner_user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    show: watcherShow('show').notNull().default('speakers'),
    windowMinutes: integer('window_minutes').notNull().default(10),
    maxWatchers: integer('max_watchers').notNull().default(12),
    layout: watcherLayout('layout').notNull().default('float'),
    names: watcherNames('names').notNull().default('under'),
    entrance: watcherEntrance('entrance').notNull().default('fade'),
    motion: watcherMotion('motion').notNull().default('drift'),
    color: watcherColor('color').notNull().default('flair'),
    /** Percent of the standard pace, size, distance and edge margin. */
    speedPercent: integer('speed_percent').notNull().default(100),
    sizePercent: integer('size_percent').notNull().default(100),
    roamPercent: integer('roam_percent').notNull().default(100),
    insetPercent: integer('inset_percent').notNull().default(4),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'watcher_embed_settings_window_range',
      sql`${table.windowMinutes} between 1 and 1440`,
    ),
    check(
      'watcher_embed_settings_max_range',
      sql`${table.maxWatchers} between 1 and 100`,
    ),
    check(
      'watcher_embed_settings_speed_range',
      sql`${table.speedPercent} between 10 and 400`,
    ),
    check('watcher_embed_settings_size_range', sql`${table.sizePercent} between 25 and 400`),
    check('watcher_embed_settings_roam_range', sql`${table.roamPercent} between 0 and 300`),
    check('watcher_embed_settings_inset_range', sql`${table.insetPercent} between 0 and 25`),
  ],
);

export const stationState = pgTable(
  'station_state',
  {
    stationId: uuid('station_id')
      .primaryKey()
      .references(() => stations.id, { onDelete: 'cascade' }),
    currentQueueItemId: uuid('current_queue_item_id').references(() => queueItems.id),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    queueItemId: uuid('queue_item_id').references(() => queueItems.id),
    mediaId: uuid('media_id').references(() => media.id),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('moderation_actions_created_at_index').on(table.createdAt)],
);

/**
 * What a source says a track is, one row per source per track.
 *
 * Keyed by the provider's own id rather than by `media.id`, because the archive
 * imported from QueUp holds 34,114 tracks that have no `media` row and never
 * will until somebody reaches for one. Genre is a property of the recording,
 * not of this station's copy of it, so one table labels both lists.
 *
 * A row with no genres is an answer too: it records that the source was asked
 * and had nothing, so an enrichment run does not ask again.
 *
 * The two vocabularies are deliberately not merged. Discogs has about fifteen
 * broad genres plus a sharper `styles` list; MusicBrainz has a folksonomy of
 * hundreds. Normalising them together manufactures both false agreement and
 * false conflict, so each source keeps its own row and its own link back.
 *
 * Nothing from the Discogs *API* belongs here. Its terms forbid storing that,
 * and `genre.ts` keeps API answers in a short-lived display cache instead. Only
 * the CC0 monthly dump is written to this table.
 */
export const trackGenres = pgTable(
  'track_genres',
  {
    provider: mediaProvider('provider').notNull(),
    providerMediaId: text('provider_media_id').notNull(),
    source: genreSource('source').notNull(),
    /** Null when the source was asked and knew nothing. */
    level: genreLevel('level'),
    genres: text('genres').array().notNull().default(sql`'{}'::text[]`),
    /** Discogs' second, sharper vocabulary. MusicBrainz has no equivalent. */
    styles: text('styles').array().notNull().default(sql`'{}'::text[]`),
    /** The MBID or Discogs master id this came from. */
    sourceEntityId: text('source_entity_id'),
    /** Where a reader can check it, which both licences ask for. */
    sourceUrl: text('source_url'),
    /**
     * Discogs attaches one video to several masters — the album, a best-of, a
     * compilation — and they do not always agree. When they disagree there is
     * no tie-break that rescues the track, so the answer is kept and marked.
     */
    ambiguous: boolean('ambiguous').notNull().default(false),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerMediaId, table.source] }),
  ],
);

/**
 * What the community played on QueUp before this station existed, kept as an
 * archive of another service's records rather than folded into `queue_items`.
 *
 * Nothing in it is a first-class part of the station: the requester is a QueUp
 * username with no Destiny account behind it, the track is whatever QueUp held
 * rather than a row in `media`, and the votes were cast somewhere else. So the
 * station's own machinery — stats, profiles, the DJ rotation, the repeat cooldown
 * — deliberately ignores this table, and the history page shows it as a
 * separate, older list.
 *
 * Rows are keyed by QueUp's own id for the play, so importing the same export
 * twice adds whatever is new and rewrites nothing.
 */
export const legacyPlays = pgTable(
  'legacy_plays',
  {
    sourceId: text('source_id').primaryKey(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    requesterName: text('requester_name').notNull(),
    provider: mediaProvider('provider').notNull(),
    providerMediaId: text('provider_media_id').notNull(),
    title: text('title').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    upvotes: integer('upvotes').notNull().default(0),
    downvotes: integer('downvotes').notNull().default(0),
    skipped: boolean('skipped').notNull().default(false),
  },
  // The history page reads this newest first; a btree scans backwards for that.
  (table) => [index('legacy_plays_played_at_index').on(table.playedAt)],
);

/**
 * Which shipped data file has already been applied.
 *
 * The archive and the genre answers are committed to the repository and applied
 * when the API starts. Left alone, that is 68,000 rows re-offered to PostgreSQL
 * on every restart to be told each one is already there — about four seconds
 * before the station can serve, spent to change nothing.
 *
 * So each file records the digest of what was applied. An unchanged file is
 * skipped; regenerating one changes its digest and it applies again by itself.
 * Nothing here is the station's data, only a note about what has been read.
 */
export const seedState = pgTable('seed_state', {
  name: text('name').primaryKey(),
  digest: text('digest').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
