-- Card buttons per installation (RFC 076 §17, services/linkCardExecuteEligibility.ts).
-- An App that is not official may call its action endpoint on a Server by
-- that Server's installation row:
-- - a server_local App's own Server (its source installation): on by default
--   while it has an action endpoint; `actions_off_at` is set when someone with
--   manageIntegrations there switches it off;
-- - any other Server: only while the endpoint in force equals
--   `allowed_action_endpoint`, which someone with manageIntegrations there
--   allowed (`actions_allowed_at`). It belongs to the row: an uninstall deletes
--   it, a reinstall starts without.
-- Who switched, allowed or withdrew is in the integration audit.
--
-- The own-Server confirmation on oauth_app_link_previews
-- (own_server_action_endpoint, own_server_actions_confirmed_at) becomes the
-- default: a server_local App whose admins confirmed it, or never decided,
-- is on. One whose admins withdrew the confirmation (the column is NULL and
-- the App's latest confirm/withdraw audit event is a withdrawal) stays off:
-- its source installation's `actions_off_at` is that withdrawal's time. The
-- old columns are left as they were and no longer read or written; the
-- serving and rollback images name them, so they are dropped a release later.
--
-- Additive. Nullable columns rewrite no rows. The CHECK is added NOT VALID and
-- stays so: every existing row is NULL in both columns, so none can violate
-- it, and every write from now on is checked; a VALIDATE would scan the table
-- under the ACCESS EXCLUSIVE lock the ADD COLUMNs took. The UPDATE touches
-- only source installations of server_local Apps with a link-preview
-- registration whose confirmation was withdrawn (a handful of rows), found
-- through the registrations and each App's audit events by
-- idx_integration_audit_client_time.
-- Locks: ACCESS EXCLUSIVE on oauth_client_installs (read by every link card
-- read and OAuth check) for the catalog changes and that UPDATE only: wait at
-- most 2 s (the deploy retries).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "allowed_action_endpoint" text;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "actions_allowed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "actions_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_actions_allowed" CHECK (("oauth_client_installs"."allowed_action_endpoint" IS NULL) = ("oauth_client_installs"."actions_allowed_at" IS NULL)) NOT VALID;--> statement-breakpoint
UPDATE "oauth_client_installs" AS i
SET "actions_off_at" = latest.created_at
FROM "oauth_app_link_previews" AS p
JOIN "oauth_clients" AS c ON c.id = p.client_id AND c.app_type = 'server_local'
CROSS JOIN LATERAL (
  SELECT e.event_type, e.created_at
  FROM "integration_audit_events" AS e
  WHERE e.client_id = p.client_id
    AND e.event_type IN ('app.link_card_actions_confirmed', 'app.link_card_actions_withdrawn')
  ORDER BY e.created_at DESC
  LIMIT 1
) AS latest
WHERE p.own_server_action_endpoint IS NULL
  AND latest.event_type = 'app.link_card_actions_withdrawn'
  AND i.client_id = c.id
  AND i.server_id = c.server_id;
