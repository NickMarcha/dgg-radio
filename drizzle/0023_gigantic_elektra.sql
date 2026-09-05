CREATE TYPE "public"."watcher_color" AS ENUM('flair', 'white');--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "color" "watcher_color" DEFAULT 'flair' NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "size_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD CONSTRAINT "watcher_embed_settings_size_range" CHECK ("watcher_embed_settings"."size_percent" between 25 and 400);