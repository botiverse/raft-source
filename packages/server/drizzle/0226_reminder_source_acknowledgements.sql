CREATE TABLE "reminder_source_acknowledgements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"reminder_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"source_event_id" uuid NOT NULL,
	"acknowledged_by_agent_id" uuid NOT NULL,
	"ack_attempt_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_source_acks_source_version_positive" CHECK ("reminder_source_acknowledgements"."source_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "reminder_source_acknowledgements" ADD CONSTRAINT "reminder_source_acknowledgements_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_source_acknowledgements" ADD CONSTRAINT "reminder_source_acknowledgements_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_source_acknowledgements" ADD CONSTRAINT "reminder_source_acknowledgements_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_source_acknowledgements" ADD CONSTRAINT "reminder_source_acknowledgements_source_event_id_reminder_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."reminder_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reminder_source_acknowledgements" ADD CONSTRAINT "reminder_source_acknowledgements_acknowledged_by_agent_id_agents_id_fk" FOREIGN KEY ("acknowledged_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reminder_source_acks_exact_unique" ON "reminder_source_acknowledgements" USING btree ("server_id","owner_agent_id","reminder_id","source_version");
--> statement-breakpoint
CREATE INDEX "idx_reminder_source_acks_attempt" ON "reminder_source_acknowledgements" USING btree ("ack_attempt_id");
