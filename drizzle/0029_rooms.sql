CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_slug_shape" CHECK ("rooms"."slug" ~ '^[a-z0-9][a-z0-9-]{1,31}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_slug_unique" ON "rooms" USING btree ("slug");--> statement-breakpoint
INSERT INTO "rooms" ("id", "slug", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'main', 'DGG Radio');--> statement-breakpoint
ALTER TABLE "room_settings" DROP CONSTRAINT "room_settings_singleton";--> statement-breakpoint
ALTER TABLE "room_settings" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "room_settings" SET "room_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "room_settings" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "room_settings" ADD PRIMARY KEY ("room_id");--> statement-breakpoint
ALTER TABLE "room_settings" ADD CONSTRAINT "room_settings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_state" DROP CONSTRAINT "room_state_singleton";--> statement-breakpoint
ALTER TABLE "room_state" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "room_state" SET "room_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "room_state" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "room_state" ADD PRIMARY KEY ("room_id");--> statement-breakpoint
ALTER TABLE "room_state" ADD CONSTRAINT "room_state_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_watch" DROP CONSTRAINT "stream_watch_singleton";--> statement-breakpoint
ALTER TABLE "stream_watch" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "stream_watch" SET "room_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "stream_watch" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "stream_watch" ADD PRIMARY KEY ("room_id");--> statement-breakpoint
ALTER TABLE "stream_watch" ADD CONSTRAINT "stream_watch_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;