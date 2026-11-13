-- agent_inbox_skip_records.recorded_xid: the transaction id of the
-- acknowledgement that wrote the record (pg_current_xact_id(), set by the
-- column default). Cleanup deleted a record once the current snapshot's xmin
-- reached the recorded snapshot's xmax, but xmax is latestCompletedXid + 1,
-- not the next xid to be assigned: a transaction with an xid at or above it
-- may already have been running (and is not in xip). When every lower xid
-- finished, xmin passed the old xmax while that transaction was still open,
-- and its row was never handed over. Xids are assigned in order, so every
-- transaction that held an xid when the snapshot was taken has a lower id than
-- the acknowledgement's; cleanup now waits for xmin to pass recorded_xid
-- (services/agentInboxLateRows.ts).
--
-- Not declared in db/schema.ts (drizzle has no xid8 column type), like
-- messages.insert_xid: the column default fills it on every insert. Nullable,
-- no backfill: the ADD COLUMN has no default (catalog only), and the default
-- is set separately so it applies to new rows only. Records written before
-- this have NULL and are cleaned up by the old condition after one hour.
-- schema-snapshot: unchanged (recorded_xid is not declared in db/schema.ts: drizzle has no xid8 type, like messages.insert_xid)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_inbox_skip_records" ADD COLUMN "recorded_xid" "xid8";--> statement-breakpoint
ALTER TABLE "agent_inbox_skip_records" ALTER COLUMN "recorded_xid" SET DEFAULT pg_current_xact_id();
