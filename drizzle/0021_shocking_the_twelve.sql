CREATE TYPE "public"."watcher_entrance" AS ENUM('fade', 'spin', 'slide', 'random');--> statement-breakpoint
CREATE TYPE "public"."watcher_layout" AS ENUM('float', 'safe', 'rail', 'column', 'sides', 'climb');--> statement-breakpoint
CREATE TYPE "public"."watcher_names" AS ENUM('under', 'beside', 'off');--> statement-breakpoint
CREATE TYPE "public"."watcher_show" AS ENUM('speakers', 'all', 'members');--> statement-breakpoint
CREATE TABLE "watcher_embed_settings" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"show" "watcher_show" DEFAULT 'speakers' NOT NULL,
	"window_minutes" integer DEFAULT 10 NOT NULL,
	"max_watchers" integer DEFAULT 12 NOT NULL,
	"layout" "watcher_layout" DEFAULT 'float' NOT NULL,
	"names" "watcher_names" DEFAULT 'under' NOT NULL,
	"entrance" "watcher_entrance" DEFAULT 'fade' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watcher_embed_settings_window_range" CHECK ("watcher_embed_settings"."window_minutes" between 1 and 1440),
	CONSTRAINT "watcher_embed_settings_max_range" CHECK ("watcher_embed_settings"."max_watchers" between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD CONSTRAINT "watcher_embed_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;