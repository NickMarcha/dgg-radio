ALTER TABLE "stream_watch_samples" DROP CONSTRAINT "stream_watch_samples_channel_lowercase";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP CONSTRAINT "stream_watch_samples_sampled_at_platform_channel_pk";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ALTER COLUMN "channel_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ADD CONSTRAINT "stream_watch_samples_sampled_at_channel_id_pk" PRIMARY KEY("sampled_at","channel_id");--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP COLUMN "platform";--> statement-breakpoint
ALTER TABLE "stream_watch_samples" DROP COLUMN "channel";