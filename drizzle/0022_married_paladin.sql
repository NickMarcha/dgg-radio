CREATE TYPE "public"."watcher_motion" AS ENUM('drift', 'bob', 'orbit', 'sway');--> statement-breakpoint
ALTER TYPE "public"."watcher_layout" ADD VALUE 'bump';--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "motion" "watcher_motion" DEFAULT 'drift' NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "speed_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "roam_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD COLUMN "inset_percent" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD CONSTRAINT "watcher_embed_settings_speed_range" CHECK ("watcher_embed_settings"."speed_percent" between 10 and 400);--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD CONSTRAINT "watcher_embed_settings_roam_range" CHECK ("watcher_embed_settings"."roam_percent" between 0 and 300);--> statement-breakpoint
ALTER TABLE "watcher_embed_settings" ADD CONSTRAINT "watcher_embed_settings_inset_range" CHECK ("watcher_embed_settings"."inset_percent" between 0 and 25);