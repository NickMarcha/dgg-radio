CREATE TABLE "media_lookups" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" "media_provider" NOT NULL,
	"metadata" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
