CREATE TABLE "agent_activity_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"activity" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"entries" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_activity_events" ADD CONSTRAINT "agent_activity_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_activity_events_agent_created" ON "agent_activity_events" USING btree ("agent_id","created_at");