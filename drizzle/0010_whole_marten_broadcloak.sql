CREATE TABLE "user_chat_counts" (
	"user_id" uuid NOT NULL,
	"term" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "user_chat_counts_user_id_term_pk" PRIMARY KEY("user_id","term")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "top_emote" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_chat_counts" ADD CONSTRAINT "user_chat_counts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;