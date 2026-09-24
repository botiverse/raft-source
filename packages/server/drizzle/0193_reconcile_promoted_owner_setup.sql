-- task/#4883 backfill: reconcile existing drifted owner rows.
--
-- Setup state is per-member (`server_members.setup_status`), but "this server has Cindy" is a
-- per-server fact (`servers.onboarding_agent_id`, which is what the projection reads as
-- `everHadAgent`). A member who joined an already-configured server and was later promoted to
-- owner kept their membership row at a pre-checkpoint status. Setup is owner-only, so after the
-- promotion the projection reads that row and shows them "Meet Cindy / Create Cindy" for an
-- agent that already exists — with no way to dismiss it.
--
-- The code fix (updateMemberRole) reconciles this going forward on every promotion. This
-- migration clears the EXISTING drifted rows.
--
-- Predicate is `server_members.role = 'owner'`, NOT `servers.owner_id`: a promoted co-owner has
-- role='owner' but is not the owner_id column, and they are precisely the affected population.
-- Scope: non-deleted servers that crossed the checkpoint (onboarding_agent_id set). Rows already
-- 'complete' are never touched, so existing normal / grandfathered / complete_after_defer /
-- admin_override completions keep their reason.
UPDATE "server_members" sm
SET "setup_status" = 'complete', "setup_completion_reason" = 'grandfathered'
FROM "servers" s
WHERE sm."server_id" = s."id"
  AND s."deleted_at" IS NULL
  AND s."onboarding_agent_id" IS NOT NULL
  AND sm."role" = 'owner'
  AND sm."setup_status" <> 'complete';
