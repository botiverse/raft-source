-- How an external agent's person said it would connect when it was made
-- (#wg-external-agent-ux:#2): `existing_agent` (an existing agent's CLI login)
-- or `sdk` (their own program with the Raft SDK). Only which instructions the
-- agent page shows first: either kind may connect either way. Null for every
-- agent made before this (an external one is shown as `existing_agent`) and
-- for every managed agent.
--
-- Catalog-only: a nullable column with no default rewrites nothing under the
-- ACCESS EXCLUSIVE lock. agents is read on every request, so give up after 2 s
-- (the deploy retries) rather than queue reads behind a long transaction.
--
-- No index (read from the agent row), no backfill. The allowed values are the
-- application's enum, as for agents' other text enums; no CHECK, so a later
-- method needs no migration.
--
-- Rolling deploy: an older replica names its own columns, never this one; an
-- agent it creates has none, which reads as `existing_agent`.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "external_setup_method" text;
