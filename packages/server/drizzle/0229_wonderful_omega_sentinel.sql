ALTER TABLE "tasks" ADD COLUMN "requires_resource_receipt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_receipt_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_receipt_recorded_by_type" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_receipt_recorded_by_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_teardown_owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resource_expiry_followup_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resource_teardown_owner_agent_id_agents_id_fk" FOREIGN KEY ("resource_teardown_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resource_expiry_followup_id_reminders_id_fk" FOREIGN KEY ("resource_expiry_followup_id") REFERENCES "public"."reminders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resource_receipt_shape_check" CHECK ("tasks"."resource_receipt" IS NULL OR (
      jsonb_typeof("tasks"."resource_receipt") = 'object'
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'object', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'purpose', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'teardown_owner', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'security_privacy', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'expiry', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'runbook', '')) <> ''
      AND btrim(COALESCE("tasks"."resource_receipt" ->> 'tracking', '')) <> ''
    ));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resource_receipt_state_check" CHECK ((
      "tasks"."resource_receipt" IS NULL
      AND "tasks"."resource_receipt_recorded_at" IS NULL
      AND "tasks"."resource_receipt_recorded_by_type" IS NULL
      AND "tasks"."resource_receipt_recorded_by_id" IS NULL
      AND "tasks"."resource_teardown_owner_agent_id" IS NULL
      AND "tasks"."resource_expiry_followup_id" IS NULL
    ) OR (
      "tasks"."requires_resource_receipt" = true
      AND "tasks"."resource_receipt" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_at" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_by_type" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_by_id" IS NOT NULL
      AND "tasks"."resource_teardown_owner_agent_id" IS NOT NULL
      AND "tasks"."resource_expiry_followup_id" IS NOT NULL
    ));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resource_receipt_completion_check" CHECK ("tasks"."status" <> 'done' OR "tasks"."requires_resource_receipt" = false OR (
      "tasks"."resource_receipt" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_at" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_by_type" IS NOT NULL
      AND "tasks"."resource_receipt_recorded_by_id" IS NOT NULL
      AND "tasks"."resource_teardown_owner_agent_id" IS NOT NULL
      AND "tasks"."resource_expiry_followup_id" IS NOT NULL
    ));