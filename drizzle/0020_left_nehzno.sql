CREATE TABLE "stream_watch_samples" (
	"sampled_at" timestamp with time zone NOT NULL,
	"platform" "watch_platform" NOT NULL,
	"channel" text NOT NULL,
	"site_count" integer,
	"chat_count" integer NOT NULL,
	"live" boolean NOT NULL,
	CONSTRAINT "stream_watch_samples_sampled_at_platform_channel_pk" PRIMARY KEY("sampled_at","platform","channel"),
	CONSTRAINT "stream_watch_samples_channel_lowercase" CHECK ("stream_watch_samples"."channel" = lower("stream_watch_samples"."channel")),
	CONSTRAINT "stream_watch_samples_site_count_nonnegative" CHECK ("stream_watch_samples"."site_count" is null or "stream_watch_samples"."site_count" >= 0),
	CONSTRAINT "stream_watch_samples_chat_count_nonnegative" CHECK ("stream_watch_samples"."chat_count" >= 0)
);
