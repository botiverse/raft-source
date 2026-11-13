-- Skipped rows of an external agent's inbox (services/agentInboxLateRows.ts):
-- per acknowledged /events batch, the read-position ranges its ack passed, the
-- rows handed over in them and the pull's snapshot (deleted once no
-- transaction of that snapshot can still commit); and a cursor-mode batch's
-- pending snapshot and late rows. New tables only; the FKs take a brief lock
-- on agents, bounded like other migrations.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "agent_inbox_late_pending" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"snapshot" text NOT NULL,
	"late" jsonb NOT NULL,
	"cursor" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inbox_late_pending_late_cap" CHECK (jsonb_typeof("agent_inbox_late_pending"."late") = 'array' AND jsonb_array_length("agent_inbox_late_pending"."late") <= 100)
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_skip_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"snapshot" text NOT NULL,
	"ranges" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_inbox_late_pending" ADD CONSTRAINT "agent_inbox_late_pending_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbox_skip_records" ADD CONSTRAINT "agent_inbox_skip_records_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_inbox_skip_records_agent" ON "agent_inbox_skip_records" USING btree ("agent_id","created_at");