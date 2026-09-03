CREATE TABLE "seed_state" (
	"name" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
