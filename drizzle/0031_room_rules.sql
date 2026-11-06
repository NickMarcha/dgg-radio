DROP INDEX "rules_name_lower_unique";--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "room_id" uuid;--> statement-breakpoint
UPDATE "rules" SET "room_id" = '00000000-0000-4000-8000-000000000001';--> statement-breakpoint
ALTER TABLE "rules" ALTER COLUMN "room_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rules_room_name_lower_unique" ON "rules" USING btree ("room_id",lower("name"));