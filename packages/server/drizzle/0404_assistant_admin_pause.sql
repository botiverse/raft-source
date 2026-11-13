ALTER TABLE "agents" ADD COLUMN "assistant_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "assistant_paused_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_assistant_paused_by_user_id_users_id_fk" FOREIGN KEY ("assistant_paused_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_assistant_paused_by_user_id_users_id_fk";