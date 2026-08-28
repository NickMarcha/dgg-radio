CREATE SEQUENCE "public"."dj_rotation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
DROP INDEX "queue_items_requester_status_index";--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "rotation_seq" bigint;--> statement-breakpoint
CREATE INDEX "users_rotation_index" ON "users" USING btree ("rotation_seq");--> statement-breakpoint
CREATE INDEX "queue_items_requester_status_index" ON "queue_items" USING btree ("requested_by_user_id","status","position");--> statement-breakpoint

-- Existing queues predate both columns: every item sits at position 0 and
-- nobody holds a place in the rotation, so nothing would ever be chosen.
-- Give each person's waiting tracks their requested order, then seat everyone
-- who has something waiting.
UPDATE "queue_items" AS q
SET "position" = ordered.rn - 1
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "requested_by_user_id" ORDER BY "requested_at"
  ) AS rn
  FROM "queue_items" WHERE "status" = 'queued'
) AS ordered
WHERE q."id" = ordered."id";--> statement-breakpoint

UPDATE "users"
SET "rotation_seq" = nextval('dj_rotation_seq')
WHERE "id" IN (SELECT DISTINCT "requested_by_user_id" FROM "queue_items" WHERE "status" = 'queued');
