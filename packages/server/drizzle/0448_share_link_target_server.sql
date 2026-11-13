-- Private share links are bound to one target Server and used once
-- (#proj-apps:769a57d4, part of the Login with Raft identity work).
--   target_server_id    the only Server the link installs on, resolved from the
--                       slug the creator typed. NULL when that slug named no
--                       Server: such a link answers like any bad link and can
--                       never be redeemed.
--   target_server_slug  the slug as typed (lowercased), what the editor lists.
--   consumed_at         when an install redeemed the link; revoked_at is set
--                       in the same transaction, so "active" stays
--                       revoked_at IS NULL everywhere.
-- One active link per App becomes one per (App, target): by Server id and by
-- the typed slug.
--
-- At deploy every active link without a target is retired (revoked_at = now();
-- the table has no reason column). Installations made through those links are
-- untouched. The CHECK then keeps an unbound link from ever being active again.
--
-- oauth_client_share_links holds tens of rows: bound the lock wait so a long
-- transaction makes the deploy retry instead of queueing share-link reads. The
-- foreign key to servers is added NOT VALID (no scan while ADD CONSTRAINT holds
-- its lock) and validated in its own statement, as 0420/0424 do for small
-- tables; every existing target_server_id is NULL, so VALIDATE checks nothing.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD COLUMN "target_server_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD COLUMN "target_server_slug" text;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "oauth_client_share_links" SET "revoked_at" = now(), "updated_at" = now()
WHERE "revoked_at" IS NULL AND "target_server_slug" IS NULL;--> statement-breakpoint
DROP INDEX "idx_oauth_client_share_links_active_client";--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD CONSTRAINT "oauth_client_share_links_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" VALIDATE CONSTRAINT "oauth_client_share_links_target_server_id_servers_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_client_share_links_active_target_server" ON "oauth_client_share_links" USING btree ("client_id","target_server_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_client_share_links_active_target_slug" ON "oauth_client_share_links" USING btree ("client_id","target_server_slug") WHERE revoked_at is null;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD CONSTRAINT "oauth_client_share_links_active_has_target" CHECK ("oauth_client_share_links"."revoked_at" IS NOT NULL OR "oauth_client_share_links"."target_server_slug" IS NOT NULL);
