CREATE TYPE "public"."rule_enforcement" AS ENUM('blocklist', 'advisory');--> statement-breakpoint
CREATE TYPE "public"."rule_entry_type" AS ENUM('track', 'artist');--> statement-breakpoint
CREATE TABLE "rule_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"provider" "media_provider" NOT NULL,
	"entry_type" "rule_entry_type" NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"note" text,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enforcement" "rule_enforcement" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_entries" ADD CONSTRAINT "rule_entries_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_entries" ADD CONSTRAINT "rule_entries_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rule_entries_target_unique" ON "rule_entries" USING btree ("provider","entry_type","provider_id");--> statement-breakpoint
CREATE INDEX "rule_entries_rule_index" ON "rule_entries" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rules_name_lower_unique" ON "rules" USING btree (lower("name"));