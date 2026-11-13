-- Interactive link cards for an App's own Server (RFC 076 §17): the action
-- endpoint a person with manageIntegrations on the App's own Server confirmed,
-- exactly as they saw it, and when. On that Server only, a card of an App that
-- is not official may call its action endpoint while the confirmed one equals
-- `action_endpoint` and the registration is not suspended
-- (services/linkCardExecuteEligibility.ts). Who confirmed or withdrew it is in
-- the integration audit (app.link_card_actions_confirmed / _revoked).
--
-- Existing rows stay NULL: no backfill, no default, no NOT NULL. Safe for the
-- serving and rollback images: none of them reads or writes these columns
-- (drizzle names its columns, so older images never see them), and NULL means
-- "not confirmed", which is what every App has today.
--
-- Additive only. Nullable columns rewrite no rows. The CHECK is added NOT
-- VALID and stays so: every existing row is NULL in both columns, so none can
-- violate it, and every write from now on is checked; a VALIDATE would scan
-- the table under the ACCESS EXCLUSIVE lock the ADD COLUMNs took.
-- Locks: ACCESS EXCLUSIVE on oauth_app_link_previews (read by every link card
-- read) for the catalog changes only: wait at most 2 s (the deploy retries).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "own_server_action_endpoint" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "own_server_actions_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD CONSTRAINT "oauth_app_link_previews_own_server_actions" CHECK (("oauth_app_link_previews"."own_server_action_endpoint" IS NULL) = ("oauth_app_link_previews"."own_server_actions_confirmed_at" IS NULL)) NOT VALID;
