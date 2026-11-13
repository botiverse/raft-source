-- #proj-raft-computer task #38: when this machine's daemon found its current
-- `sk_machine_*` key in a legacy file inside an agent workspace. A nullable
-- column with no default (catalog only, no rewrite, no backfill); older server
-- code never names it, so rolling back leaves it unused. The ADD COLUMN takes
-- ACCESS EXCLUSIVE on `daemons`, which connects and heartbeats write: give up
-- after 2 s rather than queue every daemon's connection behind a long
-- transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "credential_exposure_found_at" timestamp with time zone;
