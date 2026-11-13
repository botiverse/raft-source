-- agent_config_change_events: one row per change of an agent's configured
-- runtime / model / reasoning_effort (and one at creation), written in the
-- transaction that writes the agents row. agents keeps only the current
-- values. No runtime_config, env vars or message content (may hold secrets).
--
-- Bounded lock wait: the foreign keys lock agents and servers briefly; give
-- up after 2 s (the deploy retries) rather than queue their writes behind a
-- long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_config_change_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text,
	"actor_id" uuid,
	"source" text NOT NULL,
	"before_runtime" text,
	"after_runtime" text NOT NULL,
	"before_model" text,
	"after_model" text NOT NULL,
	"before_reasoning_effort" text,
	"after_reasoning_effort" text,
	CONSTRAINT "agent_config_change_events_actor_kind_check" CHECK ("agent_config_change_events"."actor_kind" IS NULL OR "agent_config_change_events"."actor_kind" IN ('user', 'agent', 'system'))
);
--> statement-breakpoint
ALTER TABLE "agent_config_change_events" ADD CONSTRAINT "agent_config_change_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_change_events" ADD CONSTRAINT "agent_config_change_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_config_change_events_agent_changed" ON "agent_config_change_events" USING btree ("agent_id","changed_at");--> statement-breakpoint
CREATE INDEX "idx_agent_config_change_events_server" ON "agent_config_change_events" USING btree ("server_id");