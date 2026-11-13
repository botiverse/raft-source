-- Workspace Artifacts: the record an operator's purge of one Artifact leaves
-- (apps/artifacts/purge.ts purgeArtifact; runbook
-- docs/operations/artifact-takedown.md), one new, empty table with all its
-- constraints (no NOT VALID / VALIDATE split: it is empty). Only the counts
-- removed and the reason, with the Artifact's and server's ids and when, and
-- the storage keys whose delete hasn't succeeded yet. No foreign key, so it
-- outlives the Artifact and its server.
--
-- Rolling deploy and rollback: older server code never names the table. It
-- references nothing, so it locks no existing table; the lock timeout is kept
-- anyway so a migration never queues behind a long transaction: give up after
-- 2 s, and the deploy retries.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "app_artifacts"."purges" (
	"item_id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"removed" jsonb NOT NULL,
	"pending_object_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purges_reason_length" CHECK (char_length("app_artifacts"."purges"."reason") BETWEEN 1 AND 1000)
);
