-- The NOT NULL columns below have no default, so this migration needs an empty
-- link_card_operations. Nothing writes the link_card_* tables yet (the endpoints
-- ship in RFC 076 PR C2, behind a flag that is off), so any row here is test
-- data: clear the tables first, children before their parent (the foreign keys
-- are immediate and ON DELETE NO ACTION). Added after 0400 had applied on
-- staging; drizzle tracks applied migrations by their "when", not their
-- content, so staging does not re-run it (Tenny/Arkbriar, v1.21.28).
DELETE FROM "link_card_views";--> statement-breakpoint
DELETE FROM "link_card_update_tokens";--> statement-breakpoint
DELETE FROM "link_card_attempts";--> statement-breakpoint
DELETE FROM "link_card_handle_uses";--> statement-breakpoint
DELETE FROM "link_card_client_requests";--> statement-breakpoint
DELETE FROM "link_card_prepared_actions";--> statement-breakpoint
DELETE FROM "link_card_operations";--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "url_sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "action_endpoint_sha256" text;--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "action_origin" text;--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD COLUMN "first_send_deadline" timestamp with time zone NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_viewer_url_open" ON "link_card_operations" USING btree ("viewer_id","server_id","message_id","url_sha256","created_at","operation_id") WHERE "link_card_operations"."state" IN ('sent', 'accepted', 'unknown', 'needs_reconciliation');--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_send_deadline" ON "link_card_operations" USING btree ("first_send_deadline") WHERE "link_card_operations"."state" = 'sent';--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD CONSTRAINT "link_card_operations_url_sha256_valid" CHECK ("link_card_operations"."url_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD CONSTRAINT "link_card_operations_send_target" CHECK (("link_card_operations"."provider_kind" = 'app' AND "link_card_operations"."action_endpoint_sha256" ~ '^[0-9a-f]{64}$' AND "link_card_operations"."action_origin" IS NOT NULL)
    OR ("link_card_operations"."provider_kind" = 'native' AND "link_card_operations"."action_endpoint_sha256" IS NULL AND "link_card_operations"."action_origin" IS NULL));--> statement-breakpoint
ALTER TABLE "link_card_operations" ADD CONSTRAINT "link_card_operations_first_send_deadline" CHECK ("link_card_operations"."created_at" = date_trunc('second', "link_card_operations"."created_at") AND "link_card_operations"."first_send_deadline" = "link_card_operations"."created_at" + interval '10 minutes');--> statement-breakpoint
-- created_at and first_send_deadline never change once written (protocol
-- v3.2.3 §5.3.4): the deadline is what bounds every execute JWT, so a late
-- sender, a sweep or an operator must not be able to move it. Enforced for
-- every writer, alongside link_card_operations_state_transition (0387).
CREATE OR REPLACE FUNCTION public.link_card_operations_guard_send_deadline()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $link_card_send_deadline$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.first_send_deadline IS DISTINCT FROM OLD.first_send_deadline THEN
    RAISE EXCEPTION 'link_card_operations: created_at and first_send_deadline are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'link_card_operations_send_deadline_immutable';
  END IF;
  RETURN NEW;
END
$link_card_send_deadline$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS link_card_operations_send_deadline_immutable ON public.link_card_operations;
--> statement-breakpoint
CREATE TRIGGER link_card_operations_send_deadline_immutable
  BEFORE UPDATE ON public.link_card_operations
  FOR EACH ROW EXECUTE FUNCTION public.link_card_operations_guard_send_deadline();
