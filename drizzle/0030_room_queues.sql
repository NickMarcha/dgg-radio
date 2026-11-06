CREATE TABLE "room_seats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"seq" bigint DEFAULT nextval('dj_rotation_seq') NOT NULL
);
--> statement-breakpoint
DROP INDEX "users_rotation_index";--> statement-breakpoint
DROP INDEX "queue_items_one_playing_unique";--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "queue_items" SET "room_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "queue_items" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_seats" ADD CONSTRAINT "room_seats_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_seats_room_seq_index" ON "room_seats" USING btree ("room_id","seq");--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_items_room_status_index" ON "queue_items" USING btree ("room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_items_one_playing_unique" ON "queue_items" USING btree ("room_id") WHERE "queue_items"."status" = 'playing';--> statement-breakpoint
INSERT INTO "room_seats" ("user_id", "room_id", "seq")
  SELECT "id", '00000000-0000-4000-8000-000000000001', "rotation_seq" FROM "users" WHERE "rotation_seq" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "rotation_seq";