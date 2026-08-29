ALTER TABLE "media_lookups" ADD COLUMN "playback_issue_code" text;--> statement-breakpoint
ALTER TABLE "media_lookups" ADD COLUMN "playback_issue_message" text;--> statement-breakpoint
ALTER TABLE "media_lookups" ADD COLUMN "region_restriction" jsonb;