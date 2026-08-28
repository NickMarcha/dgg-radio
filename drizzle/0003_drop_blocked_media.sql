CREATE TYPE "public"."skip_mode" AS ENUM('absolute', 'ratio');--> statement-breakpoint
ALTER TABLE "blocked_media" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "blocked_media" CASCADE;--> statement-breakpoint
ALTER TABLE "room_settings" DROP CONSTRAINT "room_settings_country_ae";--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN "skip_mode" "skip_mode" DEFAULT 'absolute' NOT NULL;--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN "skip_downvotes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN "skip_ratio_percent" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN "reveal_requester" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "room_settings" ADD CONSTRAINT "room_settings_country_code" CHECK ("room_settings"."target_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "room_settings" ADD CONSTRAINT "room_settings_skip_downvotes" CHECK ("room_settings"."skip_downvotes" >= 1);--> statement-breakpoint
ALTER TABLE "room_settings" ADD CONSTRAINT "room_settings_skip_ratio" CHECK ("room_settings"."skip_ratio_percent" between 1 and 100);