import { sql } from 'drizzle-orm';
import type { MediaMetadata } from '../media';
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

export const userRole = pgEnum('user_role', ['listener', 'admin']);
export const userTeam = pgEnum('user_team', ['pepe', 'yee']);
export const mediaProvider = pgEnum('media_provider', ['youtube', 'soundcloud']);
/**
 * Positions in the DJ rotation. Joining the rotation or being sent to the back
 * both take the next value, so ascending order is the play order.
 */
export const djRotation = pgSequence('dj_rotation_seq');

export const ruleEnforcement = pgEnum('rule_enforcement', ['blocklist', 'advisory']);
export const ruleEntryType = pgEnum('rule_entry_type', ['track', 'artist']);
export const skipMode = pgEnum('skip_mode', ['absolute', 'ratio']);
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
    team: userTeam('team'),
    dggStatus: text('dgg_status').notNull(),
    dggRoles: text('dgg_roles').array().notNull().default(sql`'{}'::text[]`),
    dggFeatures: text('dgg_features').array().notNull().default(sql`'{}'::text[]`),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    /**
     * Place in the DJ rotation, or null when the user has nothing queued.
     * Lower plays sooner.
     */
    rotationSeq: bigint('rotation_seq', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_dgg_user_id_unique').on(table.dggUserId),
    index('users_rotation_index').on(table.rotationSeq),
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

/**
 * Provider lookups are paid: Apify bills per run and YouTube bills quota. This
 * holds the last successful result per track so a submission and the check just
 * before playback do not both cost. Rows are overwritten in place, never
 * deleted, so a re-check that fails leaves the previous answer visible.
 *
 * Keys carry no country. The room is pinned to AE by a check constraint on
 * room_settings, so a cached YouTube availability answer is only ever for AE.
 */
export const mediaLookups = pgTable('media_lookups', {
  key: text('key').primaryKey(),
  provider: mediaProvider('provider').notNull(),
  metadata: jsonb('metadata').$type<MediaMetadata>().notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
});

export const queueItems = pgTable(
  'queue_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
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
  },
  (table) => [
    index('queue_items_status_requested_index').on(table.status, table.requestedAt),
    index('queue_items_requester_status_index').on(
      table.requestedByUserId,
      table.status,
      table.position,
    ),
    uniqueIndex('queue_items_one_playing_unique')
      .on(table.status)
      .where(sql`${table.status} = 'playing'`),
  ],
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
 * A rule is a named reason an admin can act on. Some are enforced by matching a
 * growing list of tracks and artists, others exist only to be read by listeners.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    enforcement: ruleEnforcement('enforcement').notNull(),
    position: integer('position').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('rules_name_lower_unique').on(sql`lower(${table.name})`)],
);

/**
 * One blocked track or artist, attributed to the rule it broke. Blocking an
 * artist covers their whole catalogue; a collaboration released under someone
 * else's channel needs its own track entry.
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
    // One thing is blocked once, under one rule, so the reason shown is unambiguous.
    uniqueIndex('rule_entries_target_unique').on(table.provider, table.entryType, table.providerId),
    index('rule_entries_rule_index').on(table.ruleId),
  ],
);

export const roomSettings = pgTable(
  'room_settings',
  {
    id: integer('id').primaryKey().default(1),
    maxDurationSeconds: integer('max_duration_seconds').notNull().default(420),
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
    check('room_settings_singleton', sql`${table.id} = 1`),
    check(
      'room_settings_duration_range',
      sql`${table.maxDurationSeconds} between 60 and 1800`,
    ),
    // The region is admin-editable now, so only its shape is enforced.
    check('room_settings_country_code', sql`${table.targetCountry} ~ '^[A-Z]{2}$'`),
    check('room_settings_skip_downvotes', sql`${table.skipDownvotes} >= 1`),
    check('room_settings_skip_ratio', sql`${table.skipRatioPercent} between 1 and 100`),
  ],
);

export const roomState = pgTable(
  'room_state',
  {
    id: integer('id').primaryKey().default(1),
    currentQueueItemId: uuid('current_queue_item_id').references(() => queueItems.id),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('room_state_singleton', sql`${table.id} = 1`)],
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
