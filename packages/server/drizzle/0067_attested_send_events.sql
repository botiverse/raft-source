CREATE TABLE "attested_send_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"server_id" uuid,
	"target_type" text NOT NULL,
	"target_ref" text NOT NULL,
	"draft_id" text,
	"message_id" uuid,
	"new_message_count" integer,
	"result" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attested_send_events" ADD CONSTRAINT "attested_send_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attested_send_events" ADD CONSTRAINT "attested_send_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attested_send_events" ADD CONSTRAINT "attested_send_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_attested_send_events_created" ON "attested_send_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "idx_attested_send_events_agent_created" ON "attested_send_events" USING btree ("agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_attested_send_events_type_created" ON "attested_send_events" USING btree ("event_type","created_at");
--> statement-breakpoint
CREATE INDEX "idx_attested_send_events_server_created" ON "attested_send_events" USING btree ("server_id","created_at");
