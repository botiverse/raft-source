-- Idle task reminder (#wg-task-v2:#9): what each agent was last reminded of
-- per task (agent_task_nudges) and the reminders it was sent within the
-- hourly cap (agent_task_nudge_sends), plus the server-scoped rollout flag,
-- default off: no server is reminded until FFA adds an allow rule.
CREATE TABLE "agent_task_nudge_sends" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"item_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_task_nudges" (
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"last_reason" text NOT NULL,
	"last_nudged_at" timestamp with time zone NOT NULL,
	"seen_others_action_at" timestamp with time zone,
	"stale_since_at" timestamp with time zone,
	"stale_step" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_task_nudges_agent_id_task_id_pk" PRIMARY KEY("agent_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "agent_task_nudge_sends" ADD CONSTRAINT "agent_task_nudge_sends_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_nudges" ADD CONSTRAINT "agent_task_nudges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_nudges" ADD CONSTRAINT "agent_task_nudges_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_task_nudge_sends_agent_sent" ON "agent_task_nudge_sends" USING btree ("agent_id","sent_at");--> statement-breakpoint
CREATE INDEX "idx_agent_task_nudges_task" ON "agent_task_nudges" USING btree ("task_id");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'idle_task_reminder_v0',
	'Idle task reminder: when an agent goes idle, remind it of the open tasks assigned to it that changed or went untouched',
	true,
	false,
	'server',
	false,
	NULL,
	'idle_task_reminder_v0'
) ON CONFLICT ("key") DO NOTHING;
