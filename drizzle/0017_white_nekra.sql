CREATE TYPE "public"."genre_level" AS ENUM('recording', 'release_group', 'artist', 'master');--> statement-breakpoint
CREATE TYPE "public"."genre_source" AS ENUM('musicbrainz', 'discogs');--> statement-breakpoint
CREATE TABLE "track_genres" (
	"provider" "media_provider" NOT NULL,
	"provider_media_id" text NOT NULL,
	"source" "genre_source" NOT NULL,
	"level" "genre_level",
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"styles" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_entity_id" text,
	"source_url" text,
	"ambiguous" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_genres_provider_provider_media_id_source_pk" PRIMARY KEY("provider","provider_media_id","source")
);
