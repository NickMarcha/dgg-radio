-- Rules block artists by their provider id, which nothing captured before now.
-- Existing rows predate it: fill them with an empty id, then drop the default so
-- every new row has to supply a real one. Those rows will not match an artist
-- block until the track is requested again and the metadata refreshes.
ALTER TABLE "media" ADD COLUMN "provider_artist_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "media" ALTER COLUMN "provider_artist_id" DROP DEFAULT;--> statement-breakpoint

-- Cached lookups were stored before the metadata carried an artist id, and
-- SoundCloud entries never expire on their own. Drop them so the next lookup
-- stores the full shape.
TRUNCATE TABLE "media_lookups";
