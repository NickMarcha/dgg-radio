CREATE TYPE "public"."media_provider" AS ENUM('youtube', 'soundcloud');--> statement-breakpoint
CREATE TYPE "public"."queue_status" AS ENUM('queued', 'playing', 'played', 'skipped', 'removed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('listener', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_team" AS ENUM('pepe', 'yee');--> statement-breakpoint
CREATE TABLE "blocked_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "media_provider" NOT NULL,
	"provider_media_id" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"blocked_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "media_provider" NOT NULL,
	"provider_media_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"thumbnail_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_duration_positive" CHECK ("media"."duration_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"queue_item_id" uuid,
	"media_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_login_transactions" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" "queue_status" DEFAULT 'queued' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"moderation_reason" text
);
--> statement-breakpoint
CREATE TABLE "room_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_duration_seconds" integer DEFAULT 420 NOT NULL,
	"target_country" text DEFAULT 'AE' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "room_settings_singleton" CHECK ("room_settings"."id" = 1),
	CONSTRAINT "room_settings_duration_range" CHECK ("room_settings"."max_duration_seconds" between 60 and 1800),
	CONSTRAINT "room_settings_country_ae" CHECK ("room_settings"."target_country" = 'AE')
);
--> statement-breakpoint
CREATE TABLE "room_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"current_queue_item_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_state_singleton" CHECK ("room_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dgg_user_id" text NOT NULL,
	"username" text NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'listener' NOT NULL,
	"team" "user_team",
	"dgg_status" text NOT NULL,
	"dgg_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"dgg_features" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_played_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"queue_item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "votes_queue_item_id_user_id_pk" PRIMARY KEY("queue_item_id","user_id"),
	CONSTRAINT "votes_value_check" CHECK ("votes"."value" in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "blocked_media" ADD CONSTRAINT "blocked_media_blocked_by_user_id_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_queue_item_id_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."queue_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_settings" ADD CONSTRAINT "room_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_state" ADD CONSTRAINT "room_state_current_queue_item_id_queue_items_id_fk" FOREIGN KEY ("current_queue_item_id") REFERENCES "public"."queue_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_queue_item_id_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_media_provider_id_unique" ON "blocked_media" USING btree ("provider","provider_media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_provider_id_unique" ON "media" USING btree ("provider","provider_media_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_created_at_index" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_login_expires_at_index" ON "oauth_login_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "queue_items_status_requested_index" ON "queue_items" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "queue_items_requester_status_index" ON "queue_items" USING btree ("requested_by_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_items_one_playing_unique" ON "queue_items" USING btree ("status") WHERE "queue_items"."status" = 'playing';--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_index" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_dgg_user_id_unique" ON "users" USING btree ("dgg_user_id");--> statement-breakpoint
CREATE INDEX "users_username_lower_index" ON "users" USING btree (lower("username"));