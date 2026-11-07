-- Rooms are called stations now. Every statement renames; nothing is dropped,
-- so every row carries over as it is.
ALTER TYPE "public"."room_role" RENAME TO "station_role";--> statement-breakpoint
ALTER TABLE "rooms" RENAME TO "stations";--> statement-breakpoint
ALTER TABLE "room_settings" RENAME TO "station_settings";--> statement-breakpoint
ALTER TABLE "room_state" RENAME TO "station_state";--> statement-breakpoint
ALTER TABLE "room_seats" RENAME TO "station_seats";--> statement-breakpoint
ALTER TABLE "room_members" RENAME TO "station_members";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "station_state" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "station_seats" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "station_members" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "stream_watch" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "queue_items" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "rules" RENAME COLUMN "room_id" TO "station_id";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "can_create_rooms" TO "can_create_stations";--> statement-breakpoint
ALTER INDEX "rooms_slug_unique" RENAME TO "stations_slug_unique";--> statement-breakpoint
ALTER INDEX "queue_items_room_status_index" RENAME TO "queue_items_station_status_index";--> statement-breakpoint
ALTER INDEX "room_members_user_index" RENAME TO "station_members_user_index";--> statement-breakpoint
ALTER INDEX "room_seats_room_seq_index" RENAME TO "station_seats_station_seq_index";--> statement-breakpoint
ALTER INDEX "rules_room_name_lower_unique" RENAME TO "rules_station_name_lower_unique";--> statement-breakpoint
ALTER TABLE "stations" RENAME CONSTRAINT "rooms_pkey" TO "stations_pkey";--> statement-breakpoint
ALTER TABLE "stations" RENAME CONSTRAINT "rooms_slug_shape" TO "stations_slug_shape";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_pkey" TO "station_settings_pkey";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_room_id_rooms_id_fk" TO "station_settings_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_updated_by_user_id_users_id_fk" TO "station_settings_updated_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_duration_range" TO "station_settings_duration_range";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_repeat_cooldown_range" TO "station_settings_repeat_cooldown_range";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_country_code" TO "station_settings_country_code";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_skip_downvotes" TO "station_settings_skip_downvotes";--> statement-breakpoint
ALTER TABLE "station_settings" RENAME CONSTRAINT "room_settings_skip_ratio" TO "station_settings_skip_ratio";--> statement-breakpoint
ALTER TABLE "station_state" RENAME CONSTRAINT "room_state_pkey" TO "station_state_pkey";--> statement-breakpoint
ALTER TABLE "station_state" RENAME CONSTRAINT "room_state_room_id_rooms_id_fk" TO "station_state_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "station_state" RENAME CONSTRAINT "room_state_current_queue_item_id_queue_items_id_fk" TO "station_state_current_queue_item_id_queue_items_id_fk";--> statement-breakpoint
ALTER TABLE "station_seats" RENAME CONSTRAINT "room_seats_pkey" TO "station_seats_pkey";--> statement-breakpoint
ALTER TABLE "station_seats" RENAME CONSTRAINT "room_seats_user_id_users_id_fk" TO "station_seats_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "station_seats" RENAME CONSTRAINT "room_seats_room_id_rooms_id_fk" TO "station_seats_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "station_members" RENAME CONSTRAINT "room_members_room_id_user_id_pk" TO "station_members_station_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "station_members" RENAME CONSTRAINT "room_members_room_id_rooms_id_fk" TO "station_members_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "station_members" RENAME CONSTRAINT "room_members_user_id_users_id_fk" TO "station_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "station_members" RENAME CONSTRAINT "room_members_added_by_user_id_users_id_fk" TO "station_members_added_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "stream_watch" RENAME CONSTRAINT "stream_watch_room_id_rooms_id_fk" TO "stream_watch_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "queue_items" RENAME CONSTRAINT "queue_items_room_id_rooms_id_fk" TO "queue_items_station_id_stations_id_fk";--> statement-breakpoint
ALTER TABLE "rules" RENAME CONSTRAINT "rules_room_id_rooms_id_fk" TO "rules_station_id_stations_id_fk";--> statement-breakpoint
-- The moderation log stores its action names, and one of them named the room.
UPDATE "moderation_actions" SET "action" = 'reorder_station_queue' WHERE "action" = 'reorder_room_queue';
