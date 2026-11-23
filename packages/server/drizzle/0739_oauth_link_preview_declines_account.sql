-- Account-mode link-preview declines (RFC 079 phase 3b, D17). For an App in
-- account mode a person's link-preview choice is one per (person, App), not
-- one per (person, Server, App): allowing writes the account consent
-- (oauth_user_consents with server_id NULL, migration 0560), and declining
-- writes a decline with server_id NULL here, which hides the App's previews
-- and prompts on every Server. Server-mode Apps keep their per-Server rows
-- exactly as before; every existing row keeps its server_id.
--
-- The database holds the shape, as 0560 does for the login rows:
-- - idx_oauth_link_preview_declines_user_client_account: one server-less
--   decline per (user, App), the decline upsert's ON CONFLICT target (the
--   (user, server, client) index treats NULLs as distinct).
-- - oauth_link_preview_declines_login_mode_guard: 0560's
--   oauth_login_row_mode_guard, unchanged. A server-less decline needs an
--   account-mode App, else check_violation
--   oauth_link_preview_declines_server_id_null_account_only; a Server-bound
--   one is not checked (its rule (b) covers requests and tokens only), so
--   declines written before an App switched stay writable and deletable.
--
-- Rolling deploy and rollback: the previous release always writes a
-- server_id and never reads a NULL one. Nothing writes a NULL one until an
-- App is in account mode, and none switches before RFC 079 phase 3c, which
-- follows this release (docs/operations/oauth-login-mode-switch.md).
--
-- Lock budget: oauth_link_preview_declines is small (a row per person who
-- turned an App's previews off on a Server). DROP NOT NULL is catalog-only
-- but takes ACCESS EXCLUSIVE to commit, so the partial index is built here
-- (a scan of a small table), not CONCURRENTLY. The trigger takes SHARE ROW
-- EXCLUSIVE for an instant; at run time the guard takes FOR SHARE on the
-- App's oauth_clients row for each decline written (people answering a
-- prompt). Bound the lock wait.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_link_preview_declines" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_link_preview_declines_user_client_account" ON "oauth_link_preview_declines" USING btree ("user_id","client_id") WHERE "oauth_link_preview_declines"."server_id" IS NULL;--> statement-breakpoint
CREATE TRIGGER "oauth_link_preview_declines_login_mode_guard"
BEFORE INSERT OR UPDATE OF "server_id", "client_id" ON public."oauth_link_preview_declines"
FOR EACH ROW EXECUTE FUNCTION public.oauth_login_row_mode_guard();
