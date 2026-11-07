CREATE TYPE "public"."rule_change_action" AS ENUM('add', 'remove');--> statement-breakpoint
CREATE TABLE "rule_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"action" "rule_change_action" NOT NULL,
	"provider" "media_provider" NOT NULL,
	"entry_type" "rule_entry_type" NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "rule_editors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"user_id" uuid,
	"station_id" uuid,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_editors_one_grantee" CHECK (num_nonnulls("rule_editors"."user_id", "rule_editors"."station_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "rule_follows" (
	"station_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_follows_station_id_rule_id_pk" PRIMARY KEY("station_id","rule_id")
);
--> statement-breakpoint
ALTER TABLE "rule_changes" ADD CONSTRAINT "rule_changes_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_changes" ADD CONSTRAINT "rule_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_changes" ADD CONSTRAINT "rule_changes_reverted_by_user_id_users_id_fk" FOREIGN KEY ("reverted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_editors" ADD CONSTRAINT "rule_editors_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_editors" ADD CONSTRAINT "rule_editors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_editors" ADD CONSTRAINT "rule_editors_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_editors" ADD CONSTRAINT "rule_editors_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_follows" ADD CONSTRAINT "rule_follows_station_id_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_follows" ADD CONSTRAINT "rule_follows_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_changes_rule_created_index" ON "rule_changes" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_editors_rule_user_unique" ON "rule_editors" USING btree ("rule_id","user_id") WHERE "rule_editors"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_editors_rule_station_unique" ON "rule_editors" USING btree ("rule_id","station_id") WHERE "rule_editors"."station_id" is not null;--> statement-breakpoint
CREATE INDEX "rule_follows_rule_index" ON "rule_follows" USING btree ("rule_id");