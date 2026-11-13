-- task #1357 item 1: agent_model_limits_reports, model limits reports from the
-- daemons (`agent:model_limits`), one row per (agent, Computer, daemon
-- instance): the contextWindow and maxTokens a Pi session registered for a
-- Built-in custom gateway model, each with its source, and that session's
-- launch, session and config revision. A new, empty table: no backfill (only
-- daemons with the new capability write it). Older server code never names
-- it, so rolling back leaves it unused.
--
-- Bounded lock wait: the foreign keys lock agents, servers and daemons briefly;
-- give up after 2 s (the deploy retries) rather than queue their writes behind
-- a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_model_limits_reports" (
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"daemon_instance_id" text NOT NULL,
	"launch_id" text,
	"session_id" text NOT NULL,
	"config_revision" bigint NOT NULL,
	"seq" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"runtime" text NOT NULL,
	"model_limits" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_limits_reports_agent_id_machine_id_daemon_instance_id_pk" PRIMARY KEY("agent_id","machine_id","daemon_instance_id")
);
--> statement-breakpoint
ALTER TABLE "agent_model_limits_reports" ADD CONSTRAINT "agent_model_limits_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_limits_reports" ADD CONSTRAINT "agent_model_limits_reports_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_limits_reports" ADD CONSTRAINT "agent_model_limits_reports_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_model_limits_reports_machine" ON "agent_model_limits_reports" USING btree ("machine_id");