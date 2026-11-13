-- Artifacts drop names (#proj-workspace:98241a2e, xxchan and Tenny; task
-- #134; docs/development/workspace-artifacts.md): an Artifact is its id and
-- its title. `app_artifacts.items.name` stays for the Artifacts that have one
-- (made before titles, or imported from raft-artifacts.com), as an alias the
-- agent API still resolves; every Artifact made from now on has none (NULL).
-- Only an app_artifacts table, behind workspace_artifacts_v0.
--
-- The partial unique indexes idx_items_live_name_conversation and
-- idx_items_live_name_server_home stay as they are: NULLs are distinct in a
-- unique index, so Artifacts without a name never collide, and the old names
-- stay unique per home (moves, restores and imports still check them).
--
-- Dropping NOT NULL reads no rows (no validation scan); bounded lock wait:
-- give up after 5s (the deploy retries) rather than queue items' writes
-- behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ALTER COLUMN "name" DROP NOT NULL;
