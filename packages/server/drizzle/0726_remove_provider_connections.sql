-- Remove saved provider connections (provider_connections_v0), code and data
-- (stdrc; an internal feature behind its flag). The flag row stays: flags
-- change only through the FFA API (configuration version, reason, audit;
-- Gogo 11-03), so Tenny deletes it there after the deploy.
--
-- This migration removes the data only. The tables stay for one release:
-- the release before this one (1.30.x) reads agent_provider_connections on
-- every agent start and config push, so dropping them would fail starts on
-- the old tasks during the deploy and make 1.30.x unusable as the rollback
-- target (docs/operations/aws-ecs-canary-release.md: no drop of a table the
-- rollback image still queries). The DROPs follow in a later migration, in
-- the release after this one.
--
-- 1. The stored API keys go first, as their own statement, so none is left
--    behind whatever happens to the rest.
-- 2. A Built-in agent bound to a saved connection loses that provider: its
--    runtime_config keeps its model and everything else, and it reads as a
--    Built-in agent with no provider (the edit form asks for one; a start says
--    it has no model provider). Its config revision moves, as for any config
--    change. 1.30.x then sees no connection-bound agent either.
--
-- 3. The tables are emptied, children before parents. Empty, they read as
--    "no connection" to 1.30.x, and no row is left whose NOT NULL ... ON
--    DELETE SET NULL user reference would block deleting that user now that
--    the purge no longer clears them.
--
-- The UPDATE locks the matching agents rows: give up after 2 s rather than
-- queue reads behind a long transaction (the deploy runner retries).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DELETE FROM "provider_connection_credentials";--> statement-breakpoint
UPDATE "agents"
SET "runtime_config" = "runtime_config" - 'provider',
  "config_revision" = "config_revision" + 1
WHERE "runtime_config"->>'runtime' = 'builtin'
  AND "runtime_config"->'provider'->>'kind' = 'connection';--> statement-breakpoint
DELETE FROM "provider_probe_receipts";--> statement-breakpoint
DELETE FROM "provider_probe_intents";--> statement-breakpoint
DELETE FROM "agent_provider_connections";--> statement-breakpoint
DELETE FROM "provider_connections";
