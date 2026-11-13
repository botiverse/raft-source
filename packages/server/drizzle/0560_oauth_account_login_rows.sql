-- Account-mode Login with Raft rows (RFC 079 phase 3a, PR 1; no behaviour
-- change). An account-mode login is not bound to one Server, so its request,
-- token and consent rows carry server_id NULL. Nothing writes such a row yet,
-- and no app is in account mode until the reviewed switch; every existing row
-- keeps its server_id and every server-mode path still writes one.
--
-- The database holds the shape, whatever the writer:
-- - oauth_access_requests/_tokens_server_id_human_only: a server-less row is a
--   person's (human, user set, no agent). Agent rows stay Server-bound.
-- - oauth_access_tokens_account_ttl: a server-less token lives at most an hour
--   (no refresh; RFC 079 D15).
-- - idx_oauth_user_consents_user_client_account: one server-less consent per
--   (user, App), the account consent upsert's ON CONFLICT target. The
--   (user, server, client) index treats NULLs as distinct.
-- - oauth_login_row_mode_guard (a CHECK cannot read oauth_clients):
--   (a) a server-less request, token or consent needs an account-mode App,
--       else <table>_server_id_null_account_only;
--   (b) a new Server-bound human request or token needs a server-mode App,
--       else <table>_server_id_bound_server_only. INSERT only, so rows
--       written before an App switches survive the switch; agent rows and
--       consents are exempt (account apps' agent grants stay Server-bound,
--       and the link-preview prompt writes per-Server consents until 3b).
-- - oauth_clients_login_mode_forward_only: an App never leaves account mode
--   (RFC 079 D16).
--
-- Lock budget: the three tables are small in production (requests ~30k rows
-- / 8 MB, tokens ~29k / 15 MB, consents ~600 / 288 KB). DROP NOT NULL is
-- catalog-only, but it takes ACCESS EXCLUSIVE, held to commit; so the CHECKs
-- are added validated and the partial index is built here, not NOT VALID +
-- VALIDATE or CONCURRENTLY, which would not shorten that lock inside this
-- transaction. Each scan reads a few MB. The triggers take SHARE ROW EXCLUSIVE
-- for an instant (oauth_clients included). At run time the guard takes a
-- FOR SHARE lock on the App's oauth_clients row for each row it checks
-- (about a thousand tokens a day). Bound the lock wait: give up after
-- 5 s (the deploy retries) rather than queue every login behind the DDL.
--
-- Every function body is schema-qualified with search_path pinned, as in
-- 0430 and 0407, so the guard reads public.oauth_clients whatever the
-- session's path.
--
-- Rollback: safe while no App is in account mode (no server-less rows
-- exist, and the previous release never reads login_mode). Once one exists,
-- this migration cannot be reverted.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_user_consents" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_user_consents_user_client_account" ON "oauth_user_consents" USING btree ("user_id","client_id") WHERE "oauth_user_consents"."server_id" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD CONSTRAINT "oauth_access_requests_server_id_human_only" CHECK ("oauth_access_requests"."server_id" IS NOT NULL OR ("oauth_access_requests"."principal_type" = 'human' AND "oauth_access_requests"."user_id" IS NOT NULL AND "oauth_access_requests"."agent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_server_id_human_only" CHECK ("oauth_access_tokens"."server_id" IS NOT NULL OR ("oauth_access_tokens"."principal_type" = 'human' AND "oauth_access_tokens"."user_id" IS NOT NULL AND "oauth_access_tokens"."agent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_account_ttl" CHECK ("oauth_access_tokens"."server_id" IS NOT NULL OR "oauth_access_tokens"."expires_at" <= "oauth_access_tokens"."created_at" + interval '1 hour');--> statement-breakpoint
-- One function for the three row tables. A missing App (login_mode NULL) is
-- refused by (a) but left to the client_id foreign key by (b), so a
-- server-mode insert fails exactly as before. principal_type is read only on
-- requests and tokens (consents have no such column; plpgsql resolves the
-- inner IF only when it runs, per table).
CREATE OR REPLACE FUNCTION public.oauth_login_row_mode_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $oauth_login_row_mode_guard$
DECLARE
	client_login_mode text;
BEGIN
	-- FOR SHARE: the switch (SELECT ... FOR UPDATE, then UPDATE login_mode)
	-- and a row being written queue behind each other, so a write never acts
	-- on the mode as it was before a switch that commits first. FOR KEY SHARE
	-- would not do: it does not conflict with an UPDATE of a non-key column.
	SELECT c."login_mode" INTO client_login_mode
	FROM public."oauth_clients" c
	WHERE c."id" = NEW."client_id"
	FOR SHARE OF c;
	IF NEW."server_id" IS NULL THEN
		IF client_login_mode IS DISTINCT FROM 'account' THEN
			RAISE EXCEPTION '% row without a Server needs an account-mode app (client %)', TG_TABLE_NAME, NEW."client_id"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_server_id_null_account_only';
		END IF;
	ELSIF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('oauth_access_requests', 'oauth_access_tokens') THEN
		IF NEW."principal_type" = 'human' AND client_login_mode = 'account' THEN
			RAISE EXCEPTION 'new Server-bound human % row needs a server-mode app (client %)', TG_TABLE_NAME, NEW."client_id"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_server_id_bound_server_only';
		END IF;
	END IF;
	RETURN NEW;
END
$oauth_login_row_mode_guard$;--> statement-breakpoint
CREATE TRIGGER "oauth_access_requests_login_mode_guard"
BEFORE INSERT OR UPDATE OF "server_id", "client_id" ON public."oauth_access_requests"
FOR EACH ROW EXECUTE FUNCTION public.oauth_login_row_mode_guard();--> statement-breakpoint
CREATE TRIGGER "oauth_access_tokens_login_mode_guard"
BEFORE INSERT OR UPDATE OF "server_id", "client_id" ON public."oauth_access_tokens"
FOR EACH ROW EXECUTE FUNCTION public.oauth_login_row_mode_guard();--> statement-breakpoint
CREATE TRIGGER "oauth_user_consents_login_mode_guard"
BEFORE INSERT OR UPDATE OF "server_id", "client_id" ON public."oauth_user_consents"
FOR EACH ROW EXECUTE FUNCTION public.oauth_login_row_mode_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.oauth_clients_login_mode_forward_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $oauth_clients_login_mode_forward_only$
BEGIN
	IF OLD."login_mode" = 'account' AND NEW."login_mode" <> 'account' THEN
		RAISE EXCEPTION 'app % cannot leave account login mode', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'oauth_clients_login_mode_forward_only';
	END IF;
	RETURN NEW;
END
$oauth_clients_login_mode_forward_only$;--> statement-breakpoint
CREATE TRIGGER "oauth_clients_login_mode_forward_only"
BEFORE UPDATE OF "login_mode" ON public."oauth_clients"
FOR EACH ROW EXECUTE FUNCTION public.oauth_clients_login_mode_forward_only();
