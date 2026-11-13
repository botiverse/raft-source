-- Where each Agent credential came from (#wg-rbac), expand step. Until now
-- created_by_user_id carried the creating person even for a cloud runtime's
-- credential, whose key no person ever saw. issued_via records the origin;
-- created_by_user_id is kept only for credentials a person issued.
--
-- agent_credentials is large (staging: >600k revoked runner credentials) and
-- every agent-authenticated request reads it, so every statement here is
-- metadata-only: nullable columns without a default, constraints added
-- NOT VALID (no scan, no VALIDATE here), and a trigger. Existing rows are
-- classified afterwards, in small batches outside the deploy transaction, by
-- scripts/backfill-agent-credential-issued-via.ts (db:backfill-agent-credential-issued-via);
-- that script's header holds the contract plan (VALIDATE, SET NOT NULL, drop
-- the trigger). Bounded lock wait: if a long transaction holds
-- agent_credentials or daemons, give up after 5s (the deploy retries) instead
-- of queueing every agent request behind the ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "issued_via" text;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "issued_by_machine_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_issued_by_machine_id_daemons_id_fk" FOREIGN KEY ("issued_by_machine_id") REFERENCES "public"."daemons"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_issued_via_check" CHECK ("agent_credentials"."issued_via" IS NULL OR "agent_credentials"."issued_via" IN ('human', 'provision', 'computer', 'app', 'unknown')) NOT VALID;--> statement-breakpoint
-- Rollout compatibility: a server built before 0401 (still serving during the
-- canary window, or after a rollback) inserts without issued_via. Classify such
-- a row with the backfill's rules that can be decided at insert time, so no new
-- NULL appears behind the backfill. Current code always sets issued_via, so
-- this never fires for it. A provision or bootstrap link is written after the
-- insert, so an older build's cloud-runtime mint lands as 'human' and its
-- bootstrap exchange as 'unknown'; the backfill re-runs its provision and
-- bootstrap steps over such rows. The contract migration drops the trigger.
CREATE OR REPLACE FUNCTION public.agent_credentials_issued_via_legacy_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $agent_credentials_issued_via$
BEGIN
  IF NEW.issued_via IS NULL THEN
    IF NEW.created_by_user_id IS NOT NULL THEN
      NEW.issued_via := 'human';
    ELSIF NEW.name ~ '^runner:[^:]+:[0-9a-f]{8}$' AND right(NEW.name, 8) = left(NEW.agent_id::text, 8) THEN
      NEW.issued_via := 'computer';
      SELECT a.daemon_id INTO NEW.issued_by_machine_id FROM public.agents AS a WHERE a.id = NEW.agent_id;
    ELSIF EXISTS (
      SELECT 1
      FROM public.app_bot_bindings AS b
      JOIN public.oauth_client_installs AS i ON i.id = b.install_id
      WHERE b.agent_id = NEW.agent_id
        AND NEW.name = 'app-bot:' || i.client_id::text
    ) THEN
      NEW.issued_via := 'app';
    ELSE
      NEW.issued_via := 'unknown';
    END IF;
  END IF;
  RETURN NEW;
END
$agent_credentials_issued_via$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_credentials_issued_via_legacy_writer ON public.agent_credentials;
--> statement-breakpoint
CREATE TRIGGER agent_credentials_issued_via_legacy_writer
  BEFORE INSERT ON public.agent_credentials
  FOR EACH ROW EXECUTE FUNCTION public.agent_credentials_issued_via_legacy_writer();
