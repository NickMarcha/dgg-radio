CREATE TABLE "legacy_plays" (
	"source_id" text PRIMARY KEY NOT NULL,
	"played_at" timestamp with time zone NOT NULL,
	"requester_name" text NOT NULL,
	"provider" "media_provider" NOT NULL,
	"provider_media_id" text NOT NULL,
	"title" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"thumbnail_url" text,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "legacy_plays_played_at_index" ON "legacy_plays" USING btree ("played_at");