CREATE TABLE "reminder_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reminder_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_fire_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "reminder_events" ADD CONSTRAINT "reminder_events_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_events" ADD CONSTRAINT "reminder_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_events" ADD CONSTRAINT "reminder_events_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reminder_events_reminder" ON "reminder_events" USING btree ("reminder_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_reminder_events_owner" ON "reminder_events" USING btree ("owner_agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_reminder_events_server" ON "reminder_events" USING btree ("server_id");