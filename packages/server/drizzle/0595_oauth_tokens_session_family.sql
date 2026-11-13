-- SSO v1 require-SSO (rfcs/083-server-sso.md §6.2): the Raft session family
-- an App access token was approved from, so the token carries that sign-in's
-- SSO facts (read as issued, also after that session signs out), and an index
-- on the active, required connections the enforcement cache reads. The
-- column is nullable, without a default or foreign key (a catalog-only
-- change; tokens outlive families by design); the index is on a table of a
-- few rows. Give up after 5 s rather than queue token exchanges behind a long
-- transaction; the one ALTER on the busy table goes last.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "idx_server_sso_connections_required" ON "server_sso_connections" USING btree ("server_id") WHERE "server_sso_connections"."status" = 'active' AND "server_sso_connections"."required";--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "issued_by_session_family_id" uuid;
