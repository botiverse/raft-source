-- Agent token usage (#proj-o11y:42f2af5c): per agent/model/UTC day sums and each agent's latest context use.
-- Add-only: two new empty tables; the FKs lock agents/servers only briefly.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_usage_context" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"context_used" bigint,
	"context_window" bigint,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_usage_daily" (
	"agent_id" uuid NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"server_id" uuid NOT NULL,
	"runtime" text,
	"input_new" bigint,
	"cache_read" bigint,
	"cache_write" bigint,
	"output" bigint,
	"reasoning_output" bigint,
	"turns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_daily_agent_id_day_model_pk" PRIMARY KEY("agent_id","day","model")
);
--> statement-breakpoint
ALTER TABLE "agent_usage_context" ADD CONSTRAINT "agent_usage_context_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_context" ADD CONSTRAINT "agent_usage_context_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_daily" ADD CONSTRAINT "agent_usage_daily_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_daily" ADD CONSTRAINT "agent_usage_daily_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_usage_context_server" ON "agent_usage_context" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_usage_daily_server_day" ON "agent_usage_daily" USING btree ("server_id","day");