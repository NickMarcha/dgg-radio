ALTER TABLE "stream_watch_samples" DROP CONSTRAINT "stream_watch_samples_chat_count_nonnegative";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP CONSTRAINT "stream_watch_samples_site_count_nonnegative";--> statement-breakpoint
-- The only rows with no site count are the followed channel in a minute the
-- site did not list it, which was recorded to carry a chat count. Nothing
-- reads a chat count any more, so those rows are a reading of nothing.
DELETE FROM "stream_watch_samples" WHERE "site_count" IS NULL;--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ALTER COLUMN "site_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP COLUMN "chat_count";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ADD CONSTRAINT "stream_watch_samples_site_count_nonnegative" CHECK ("stream_watch_samples"."site_count" >= 0);