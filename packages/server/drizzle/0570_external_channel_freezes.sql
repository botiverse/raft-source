-- External channel freeze (behind external_channels_v1;
-- services/externalChannelFreezeService.ts): a free server in more than one
-- external channel gets a server_external_freezes row; once its freeze_at has
-- passed, its side of every external channel is read-only. A new table, not a
-- servers column: admission paths lock the servers row FOR SHARE / FOR UPDATE,
-- and writing it there would upgrade those locks.
-- external_freeze_launch_backfill: one row once
-- scripts/external-freeze-launch-backfill.ts --apply has given the servers
-- already over at launch their grace; until then nothing creates a freeze row.
--
-- server_external_freezes.server_id has no foreign key to servers, on
-- purpose: the row is derived state, and inserting it would take a key share
-- lock on the servers row, which deadlocks with a role transition holding
-- that row FOR UPDATE while a joint accept holds the membership lock it waits
-- for. An orphan row (a server gone or soft-deleted) is harmless: the write
-- gate and channel metadata only look up existing servers, and the sweep
-- deletes orphans. Both tables are new and empty: no lock on any other table.
CREATE TABLE "external_freeze_launch_backfill" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"launch_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_freeze_launch_backfill_single_row" CHECK ("external_freeze_launch_backfill"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "server_external_freezes" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"freeze_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
