DROP INDEX "rule_entries_target_unique";--> statement-breakpoint
CREATE INDEX "rule_entries_target_index" ON "rule_entries" USING btree ("provider","entry_type","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_entries_target_unique" ON "rule_entries" USING btree ("rule_id","provider","entry_type","provider_id");