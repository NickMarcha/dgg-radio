ALTER TABLE "users" ADD COLUMN "tuned_station_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tuned_station_id_stations_id_fk" FOREIGN KEY ("tuned_station_id") REFERENCES "public"."stations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Anyone with tracks waiting is tuned to the station they are waiting in.
UPDATE "users" SET "tuned_station_id" = "station_seats"."station_id"
  FROM "station_seats" WHERE "station_seats"."user_id" = "users"."id";
