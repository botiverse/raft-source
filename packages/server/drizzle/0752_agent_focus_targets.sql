-- Focus, part 1 (agent_focus_v0): the conversations an agent keeps in focus.
-- The two foreign keys take a lock on agents and channels, both hot: bound the
-- wait so a long transaction ahead of this one cannot queue every write
-- behind the migration (same as 0742, 0744).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_focus_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source" text NOT NULL,
	"focused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_focus_targets_source_check" CHECK ("agent_focus_targets"."source" IN ('auto', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "agent_focus_targets" ADD CONSTRAINT "agent_focus_targets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_focus_targets" ADD CONSTRAINT "agent_focus_targets_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_focus_targets_agent_channel_unique" ON "agent_focus_targets" USING btree ("agent_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_agent_focus_targets_agent_active" ON "agent_focus_targets" USING btree ("agent_id","last_active_at");--> statement-breakpoint
CREATE INDEX "idx_agent_focus_targets_channel" ON "agent_focus_targets" USING btree ("channel_id");