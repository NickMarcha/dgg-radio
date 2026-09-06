CREATE TABLE "stream_watch_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"channel" text NOT NULL,
	CONSTRAINT "stream_watch_channels_channel_lowercase" CHECK ("stream_watch_channels"."channel" = lower("stream_watch_channels"."channel"))
);
--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ADD COLUMN "channel_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_watch_channels_platform_channel" ON "stream_watch_channels" USING btree ("platform","channel");--> statement-breakpoint
ALTER TABLE "stream_watch_samples" ADD CONSTRAINT "stream_watch_samples_channel_id_stream_watch_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."stream_watch_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Name every channel already sampled, then point its rows at that name rather
-- than repeating it. The next migration drops the two text columns.
INSERT INTO "stream_watch_channels" ("platform", "channel")
SELECT DISTINCT "platform", "channel" FROM "stream_watch_samples";--> statement-breakpoint
UPDATE "stream_watch_samples" AS s
SET "channel_id" = c."id"
FROM "stream_watch_channels" AS c
WHERE c."platform" = s."platform" AND c."channel" = s."channel";
