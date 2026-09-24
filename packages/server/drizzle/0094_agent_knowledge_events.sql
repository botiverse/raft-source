CREATE TABLE "agent_knowledge_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"computer_id" uuid,
	"doc_id" text,
	"topic_or_path" text NOT NULL,
	"doc_version" text,
	"doc_state" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latency_ms" integer,
	"response_bytes" integer,
	"turn_id" text,
	"trace_id" text,
	"reason" text,
	CONSTRAINT "agent_knowledge_events_source_valid" CHECK ("agent_knowledge_events"."source" IN ('cli')),
	CONSTRAINT "agent_knowledge_events_status_valid" CHECK ("agent_knowledge_events"."status" IN ('success', 'not_found', 'denied', 'error')),
	CONSTRAINT "agent_knowledge_events_doc_state_valid" CHECK ("agent_knowledge_events"."doc_state" IS NULL OR "agent_knowledge_events"."doc_state" IN ('draft', 'published', 'deprecated', 'retired')),
	CONSTRAINT "agent_knowledge_events_success_doc_version" CHECK ("agent_knowledge_events"."status" <> 'success' OR ("agent_knowledge_events"."doc_id" IS NOT NULL AND "agent_knowledge_events"."doc_version" IS NOT NULL AND "agent_knowledge_events"."doc_state" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge_events" ADD CONSTRAINT "agent_knowledge_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_knowledge_events" ADD CONSTRAINT "agent_knowledge_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_events_agent_requested" ON "agent_knowledge_events" USING btree ("agent_id","requested_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_events_server_requested" ON "agent_knowledge_events" USING btree ("server_id","requested_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_events_doc_requested" ON "agent_knowledge_events" USING btree ("doc_id","requested_at");
--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_events_status_requested" ON "agent_knowledge_events" USING btree ("status","requested_at");
