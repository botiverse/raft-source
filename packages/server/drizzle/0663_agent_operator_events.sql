-- agent_operator_events (#proj-runtime:#51): what a person did to an agent
-- (start, stop, restart, reset, Stop Current Turn, migration) and the
-- restarts Raft did by itself, for the Activity overview. Written by the
-- route that accepted the action. ids and enums only.
--
-- Bounded lock wait: the foreign keys lock agents, servers and users
-- briefly; give up after 2 s (the deploy retries) rather than queue their
-- writes behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_operator_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"kind" text NOT NULL,
	"details" jsonb,
	CONSTRAINT "agent_operator_events_actor_kind_check" CHECK ("agent_operator_events"."actor_kind" IN ('user', 'system')),
	CONSTRAINT "agent_operator_events_kind_check" CHECK ("agent_operator_events"."kind" IN ('start', 'stop', 'restart', 'reset_session', 'reset_full', 'turn_stopped', 'migration_started', 'migration_cancelled', 'system_restart'))
);
--> statement-breakpoint
ALTER TABLE "agent_operator_events" ADD CONSTRAINT "agent_operator_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operator_events" ADD CONSTRAINT "agent_operator_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operator_events" ADD CONSTRAINT "agent_operator_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_operator_events_agent_occurred" ON "agent_operator_events" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_agent_operator_events_server" ON "agent_operator_events" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_operator_events_actor" ON "agent_operator_events" USING btree ("actor_user_id") WHERE actor_user_id is not null;