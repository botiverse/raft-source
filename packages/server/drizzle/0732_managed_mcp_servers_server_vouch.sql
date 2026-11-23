-- An MCP App its Server vouched for: managed_mcp_servers.server_vouched_at (when) and
-- server_vouched_by_user_id (who, for audit; ON DELETE SET NULL, the vouch stays). From this
-- release, mcpAutoGrantCoversAgent grants every agent of the App's Server automatically when the App
-- is vouched, instead of when the App's creator CURRENTLY holds manageExternalAuth there; the
-- creator's later role no longer matters. Set by a server owner or admin creating the App in their
-- own session, or with PUT /api/mcp/apps/:appId/server-vouch; cleared there.
--
-- The rule is fail-closed: an App with no recorded creator (created_by_user_id NULL) is granted to
-- no agent automatically unless the Server vouched for it. Until this release such an App reached
-- every agent of its Server (a separate "no creator" branch, now gone).
--
-- Backfill, to keep today's behaviour as an explicit, audited, revocable decision of the Server,
-- at migration time (now(), not created_at), for MCP Apps on a live Server only:
-- - an App whose creator is an owner or admin of that Server NOW, with an account that is not
--   retired, is vouched by its creator (server_vouched_by_user_id = created_by_user_id); audit
--   reason 'backfill', requester the creator. An App whose creator is a member, left, or was
--   retired is not vouched: its automatic grants to other people's agents already stopped under
--   the old rule, and a person can vouch for it now.
-- - an App with no recorded creator (rows from before the column existed; users rows are never
--   deleted, only retired, so ON DELETE SET NULL does not produce them) is vouched by nobody
--   (server_vouched_by_user_id NULL); audit reason 'legacy_no_creator', no requester. It keeps
--   reaching every agent, now because of the vouch, which an owner or admin can turn off.
--
-- One audit row per backfilled App, as 0731 does: `app.server_vouched`, actor `system`, target the
-- MCP App (`managed_mcp_server`, as the other MCP audit rows), no oauth_clients row (client_id
-- NULL), metadata { appName, reason, backfill: true }.
--
-- Locks: ACCESS EXCLUSIVE on managed_mcp_servers for the two catalog-only ADD COLUMNs (nullable, no
-- default); ROW EXCLUSIVE for the UPDATE and on integration_audit_events. managed_mcp_servers holds
-- one row per App (small), so the backfill is one statement, not batches. server_members and users
-- (hot) are only read. The foreign key to users (hot) comes last and NOT VALID: SHARE ROW EXCLUSIVE
-- on users only at the end, with no scan (every value came from created_by_user_id, itself a key to
-- users). 2 s lock wait, then the deploy retries.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "server_vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "server_vouched_by_user_id" uuid;--> statement-breakpoint
WITH vouched AS (
  UPDATE "managed_mcp_servers" a SET "server_vouched_at" = now(), "server_vouched_by_user_id" = a."created_by_user_id"
   WHERE a."server_vouched_at" IS NULL
     AND EXISTS (SELECT 1 FROM "servers" s WHERE s."id" = a."server_id" AND s."deleted_at" IS NULL)
     AND (
       a."created_by_user_id" IS NULL
       OR EXISTS (
         SELECT 1 FROM "server_members" m
           JOIN "users" u ON u."id" = m."user_id"
          WHERE m."server_id" = a."server_id" AND m."user_id" = a."created_by_user_id"
            AND m."role" IN ('owner', 'admin') AND u."retired_at" IS NULL
       )
     )
  RETURNING a."id", a."server_id", a."name", a."created_by_user_id"
)
INSERT INTO "integration_audit_events"
  ("id", "server_id", "client_id", "event_type", "event_category", "outcome", "source", "actor_type", "requester_type", "requester_id", "subject_type", "subject_id", "target_type", "target_id", "metadata")
SELECT gen_random_uuid(), v."server_id", NULL, 'app.server_vouched', 'membership', 'success', 'system', 'system',
       CASE WHEN v."created_by_user_id" IS NULL THEN NULL ELSE 'human' END, v."created_by_user_id",
       'app', v."id", 'managed_mcp_server', v."id",
       jsonb_build_object('appName', v."name", 'reason', CASE WHEN v."created_by_user_id" IS NULL THEN 'legacy_no_creator' ELSE 'backfill' END, 'backfill', true)
  FROM vouched v;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_server_vouched_by_user_id_users_id_fk" FOREIGN KEY ("server_vouched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;
