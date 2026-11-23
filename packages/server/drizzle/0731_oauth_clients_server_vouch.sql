-- A server_local App its Server vouched for: oauth_clients.server_vouched_at (when) and
-- server_vouched_by_user_id (who, for audit; ON DELETE SET NULL, the vouch stays). From this
-- release, autoGrantAgentClientRule grants every agent of the App's Server automatically when the
-- App is vouched, instead of when the App's creator CURRENTLY holds manageExternalAuth there; the
-- creator's later role no longer matters. Set by a server owner or admin creating the App in their
-- own session, or with PUT /api/integrations/clients/:id/server-vouch; cleared there, or when an
-- agent widens the App's scopes. Ignored for other App types.
--
-- Backfill, to keep today's behaviour: each user-managed server_local App on a live Server whose
-- creator (created_by_user_id) is an owner or admin of that Server NOW, with an account that is
-- not retired, is vouched by its creator at migration time (now(), not created_at). That includes
-- an App an agent registered through a card a human admin confirmed (the admin is
-- created_by_user_id). An App whose creator is a member, left, or was retired is not vouched: its
-- automatic grants already stopped under the old rule, and a person can vouch for it now.
--
-- One audit row per backfilled App, as 0722 audits its repair: `app.server_vouched`, actor
-- `system`, requester the creator, metadata { reason: 'backfill', backfill: true }.
--
-- Locks: ACCESS EXCLUSIVE on oauth_clients for the two catalog-only ADD COLUMNs (nullable, no
-- default); ROW EXCLUSIVE for the UPDATE and on integration_audit_events. oauth_clients holds one
-- row per App (small), so the backfill is one statement, not batches. server_members and users
-- (hot) are only read. The foreign key to users (hot) comes last and NOT VALID: SHARE ROW
-- EXCLUSIVE on users only at the end, with no scan (every value came from created_by_user_id,
-- itself a key to users). 2 s lock wait, then the deploy retries.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "server_vouched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "server_vouched_by_user_id" uuid;--> statement-breakpoint
WITH vouched AS (
  UPDATE "oauth_clients" c SET "server_vouched_at" = now(), "server_vouched_by_user_id" = c."created_by_user_id"
   WHERE c."app_type" = 'server_local'
     AND c."server_vouched_at" IS NULL
     AND NOT EXISTS (SELECT 1 FROM "external_app_registrations" r WHERE r."oauth_client_id" = c."id")
     AND EXISTS (SELECT 1 FROM "servers" s WHERE s."id" = c."server_id" AND s."deleted_at" IS NULL)
     AND EXISTS (
       SELECT 1 FROM "server_members" m
         JOIN "users" u ON u."id" = m."user_id"
        WHERE m."server_id" = c."server_id" AND m."user_id" = c."created_by_user_id"
          AND m."role" IN ('owner', 'admin') AND u."retired_at" IS NULL
     )
  RETURNING c."id", c."server_id", c."client_id", c."created_by_user_id"
)
INSERT INTO "integration_audit_events"
  ("id", "server_id", "client_id", "event_type", "event_category", "outcome", "source", "actor_type", "requester_type", "requester_id", "subject_type", "subject_id", "target_type", "target_id", "metadata")
SELECT gen_random_uuid(), v."server_id", v."id", 'app.server_vouched', 'membership', 'success', 'system', 'system', 'human', v."created_by_user_id", 'app', v."id", 'app', v."id",
       jsonb_build_object('clientKey', v."client_id", 'reason', 'backfill', 'backfill', true)
  FROM vouched v;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_server_vouched_by_user_id_users_id_fk" FOREIGN KEY ("server_vouched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;
