-- One automatic retry of a web Computer upgrade that failed at a download
-- step (computerUpgradeRequestService UPGRADE_AUTO_RETRY_FAILURE_CODES).
-- On the failed request: auto_retry_failure_code (the allow-listed code that
-- qualified it), auto_retry_due_at (10 minutes after the failure),
-- auto_retry_claimed_at (set once by the replica that claims it: the claiming
-- UPDATE requires it to be null), auto_retry_result (`retried` or why it was
-- skipped). On the request the retry created: auto_retry_of_request_id, the
-- failed request (set = sent by the Server itself).
--
-- Catalog-only: nullable columns with no default rewrite nothing. No index:
-- not needed at this size (about 4,600 rows in production; one row per web
-- upgrade click). No backfill: every existing request reads as never retried.
-- Not a hot table; 2 s anyway.
--
-- Rolling deploy: an older replica names its own columns and never sets
-- these; a request it settles failed is not retried, and a retry it settles
-- keeps its link.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD COLUMN "auto_retry_failure_code" text;--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD COLUMN "auto_retry_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD COLUMN "auto_retry_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD COLUMN "auto_retry_result" text;--> statement-breakpoint
ALTER TABLE "computer_upgrade_requests" ADD COLUMN "auto_retry_of_request_id" uuid;