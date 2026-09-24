CREATE TABLE "web_push_prompt_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid,
	"event" text NOT NULL,
	"trigger" text NOT NULL,
	"result" text,
	"permission_before" text,
	"permission_after" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "dismissed_add_computer_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "dismissed_create_agent_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "dismissed_invite_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "dismissed_community_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "dismissed_notification_step_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_source_other" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_source_skipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "web_push_prompt_events" ADD CONSTRAINT "web_push_prompt_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_push_prompt_events" ADD CONSTRAINT "web_push_prompt_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_web_push_prompt_events_user_created" ON "web_push_prompt_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_web_push_prompt_events_server_created" ON "web_push_prompt_events" USING btree ("server_id","created_at");