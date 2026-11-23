-- App notices that don't wake the agent (dm:@Remy:#1): POST
-- /api/oauth/agent-events takes an optional `delivery`, `wake` (the default,
-- as before) or `inbox` (added to the agent's inbox item only). Rows from
-- before the column read `wake`, which is what they were. A constant default
-- on ADD COLUMN is a catalog change in PostgreSQL 11+: no table rewrite.
-- Every app event and inbox read touches this table, so the ALTER waits at
-- most 2 s for its lock instead of queueing them behind a long transaction
-- (Tenny); a timeout fails the migration, which is safe to re-run.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD COLUMN "delivery" text DEFAULT 'wake' NOT NULL;
