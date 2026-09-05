CREATE TYPE "public"."watch_platform" AS ENUM('kick', 'youtube', 'twitch', 'angelthump');--> statement-breakpoint
CREATE TABLE "stream_watch" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"platform" "watch_platform" DEFAULT 'kick' NOT NULL,
	"channel" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "stream_watch_singleton" CHECK ("stream_watch"."id" = 1),
	CONSTRAINT "stream_watch_channel_lowercase" CHECK ("stream_watch"."channel" = lower("stream_watch"."channel"))
);
--> statement-breakpoint
ALTER TABLE "stream_watch" ADD CONSTRAINT "stream_watch_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;