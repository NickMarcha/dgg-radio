ALTER TABLE "stream_watch_samples" DROP CONSTRAINT "stream_watch_samples_chat_count_nonnegative";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ALTER COLUMN "platform" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ALTER COLUMN "chat_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP COLUMN "live";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ADD CONSTRAINT "stream_watch_samples_chat_count_nonnegative" CHECK ("stream_watch_samples"."chat_count" is null or "stream_watch_samples"."chat_count" >= 0);