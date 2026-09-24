CREATE TABLE "computer_lifecycle_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_operation_id" uuid NOT NULL,
	"dispatch_action" text NOT NULL,
	"target_version" text NOT NULL,
	"adapter" text NOT NULL,
	"origin_server_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"phase" text DEFAULT 'accepted' NOT NULL,
	"phase_version" integer DEFAULT 0 NOT NULL,
	"phase_deadline_at" timestamp with time zone NOT NULL,
	"first_hop_progress_ordinal" integer DEFAULT 0 NOT NULL,
	"last_valid_evidence_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_source_epoch" text,
	"observed_target_generation" text,
	"current_managed_set_revision" text,
	"terminal_evidence" jsonb,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "idx_computer_lifecycle_operations_one_pending_action";--> statement-breakpoint
-- terminal_at is the slot-release fence for the new machine-wide uniqueness
-- rule. Older terminal rows were allowed to omit it, so close those slots
-- before constructing the partial index.
UPDATE "computer_lifecycle_operations"
SET "terminal_at" = COALESCE("terminal_at", "created_at")
WHERE "status" <> 'pending' AND "terminal_at" IS NULL;--> statement-breakpoint
-- The old index allowed one pending row per action. If a deployment happens
-- to contain overlapping Restart/Upgrade rows for the same Server machine,
-- preserve the oldest intent and terminalize later rows deterministically
-- before enforcing the new one-pending-U invariant.
WITH "ranked_pending_machine_operations" AS (
	SELECT "id", ROW_NUMBER() OVER (
		PARTITION BY "server_id", "machine_id"
		ORDER BY "created_at" ASC, "id" ASC
	) AS "pending_rank"
	FROM "computer_lifecycle_operations"
	WHERE "terminal_at" IS NULL AND "parent_operation_id" IS NULL
)
UPDATE "computer_lifecycle_operations" AS "operation"
SET
	"status" = 'superseded',
	"terminal_at" = now(),
	"terminal_reason" = COALESCE("terminal_reason", 'superseded_by_machine_serialization_schema')
FROM "ranked_pending_machine_operations" AS "ranked"
WHERE "operation"."id" = "ranked"."id" AND "ranked"."pending_rank" > 1;--> statement-breakpoint
-- Existing deployments may already have a pending server-dispatched U when
-- this migration lands. Give it a same-UUID D child so an unsent U remains
-- claimable by the new D-only dispatcher. A U already marked sent cannot
-- satisfy the new machine-attestation evidence contract with its historical
-- acknowledgement shape; migration 0175 terminalizes that bounded cohort.
INSERT INTO "computer_lifecycle_dispatches" (
	"id",
	"parent_operation_id",
	"dispatch_action",
	"target_version",
	"adapter",
	"origin_server_id",
	"machine_id",
	"phase_deadline_at",
	"observed_source_epoch"
)
SELECT
	"id",
	"id",
	"action",
	COALESCE("target_version", '0.72.9'),
	'legacy_pending_server_operation_v1',
	"server_id",
	"machine_id",
	COALESCE("ready_deadline_at", "shutdown_deadline_at", now() + interval '15 minutes'),
	"connection_epoch_before"
FROM "computer_lifecycle_operations"
WHERE
	"terminal_at" IS NULL
	AND "parent_operation_id" IS NULL
	AND "dispatch_mode" = 'server'
	AND "action" IN ('restart', 'upgrade')
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "computer_lifecycle_dispatches" ADD CONSTRAINT "computer_lifecycle_dispatches_parent_operation_id_computer_lifecycle_operations_id_fk" FOREIGN KEY ("parent_operation_id") REFERENCES "public"."computer_lifecycle_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_lifecycle_dispatches" ADD CONSTRAINT "computer_lifecycle_dispatches_origin_server_id_servers_id_fk" FOREIGN KEY ("origin_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_lifecycle_dispatches_parent" ON "computer_lifecycle_dispatches" USING btree ("parent_operation_id");--> statement-breakpoint
CREATE INDEX "idx_computer_lifecycle_dispatches_machine_phase" ON "computer_lifecycle_dispatches" USING btree ("machine_id","phase");--> statement-breakpoint
CREATE INDEX "idx_computer_lifecycle_dispatches_deadline" ON "computer_lifecycle_dispatches" USING btree ("phase_deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_computer_lifecycle_operations_one_pending_machine" ON "computer_lifecycle_operations" USING btree ("server_id","machine_id") WHERE terminal_at IS NULL AND parent_operation_id IS NULL;
