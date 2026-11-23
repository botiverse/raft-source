-- Remove saved providers (provider_connections_v0, #15291), step 2 of 2: drop
-- the five tables 0726 emptied.
--
-- schema-snapshot: unchanged (0726's snapshot already lacks all five tables)
--
-- Why now: 0726 (#15566) kept the tables one release because 1.30.x reads
-- them and was the rollback target for 1.31. 1.31 neither declares nor reads
-- them, so once it is the release serving production it is also the rollback
-- image for this one, and nothing that can run names these tables.
--
-- IF EXISTS: staging already dropped them (an earlier version of 0726 ran
-- there), and a database made from another history may not have them.
-- Children first; every foreign key into these tables is from one of them, so
-- no CASCADE is needed. They are empty, so the drops are catalog-only; still
-- give up after 2 s rather than queue behind a long transaction holding a
-- lock on users/servers/agents (the deploy runner retries a lock timeout).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DROP TABLE IF EXISTS "provider_probe_receipts";--> statement-breakpoint
DROP TABLE IF EXISTS "provider_probe_intents";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_provider_connections";--> statement-breakpoint
DROP TABLE IF EXISTS "provider_connection_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "provider_connections";
