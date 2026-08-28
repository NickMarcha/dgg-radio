CREATE TABLE "playback_regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
