-- App step-up with a legacy passkey on the web (services/appStepUpService.ts,
-- docs/contracts/app-web-step-up.md; flag app_web_step_up_v1, default off):
--   app_login_requests.purpose          'login' (every existing row, the app
--                                       login handoff) or 'step_up': an app's
--                                       own sign-in verified on the web.
--   app_login_requests.target_family_id step_up only (and always, CHECK): the
--                                       app's sign-in the code marks verified.
--                                       Goes with the family (CASCADE).
--   app_login_requests.step_up_action   step_up only: the StepUpAction the
--                                       app asked for, shown on the page.
--   idx_app_login_requests_step_up_pending  at most one pending step-up per
--                                       app sign-in (a new start denies the
--                                       previous one first).
--   auth_challenges.kind                + webauthn_app_step_up: the assertion
--                                       challenge of one step-up request. Its
--                                       own kind, so no other ceremony (step-up,
--                                       sign-in, passkey sign-in) consumes it,
--                                       and it consumes none of theirs.
--
-- Lock budget: app_login_requests is small (a row per app sign-in attempt).
-- The new columns are catalog-only (a constant default, no rewrite); its
-- CHECKs and the partial index scan it once. The foreign key is added NOT VALID
-- (SHARE ROW EXCLUSIVE on session_families, no scan) and validated after.
-- The VALIDATE runs in the same transaction as the ADD, so that SHARE ROW
-- EXCLUSIVE lock on session_families (blocking its writes, not its reads) is
-- held until commit, through the validation scan of app_login_requests (small)
-- and the statements below; lock_timeout bounds the wait for it. The kind CHECK is swapped as 0734 swaps
-- it: DROP and ADD ... NOT VALID side by side at the end, never validated (the
-- new list is a superset of the old one; every write from now on is checked).
--
-- Rolling deploy and rollback: the previous release neither reads nor writes
-- the new columns; its inserts get purpose 'login' and a NULL target, which
-- pass both CHECKs. It never reads a step_up row as a login: its describe,
-- approve and exchange would see one only by the row's random id or the code
-- hash, which only a step-up page or callback holds; nothing starts a step-up
-- while the flag is off.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD COLUMN "purpose" text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD COLUMN "target_family_id" uuid;--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD COLUMN "step_up_action" text;--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_target_family_id_session_families_id_fk" FOREIGN KEY ("target_family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "app_login_requests" VALIDATE CONSTRAINT "app_login_requests_target_family_id_session_families_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_login_requests_step_up_pending" ON "app_login_requests" USING btree ("target_family_id") WHERE purpose = 'step_up' AND status = 'pending';--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_purpose_check" CHECK ("app_login_requests"."purpose" IN ('login', 'step_up'));--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_step_up_target_check" CHECK (("app_login_requests"."purpose" = 'step_up') = ("app_login_requests"."target_family_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "auth_challenges" DROP CONSTRAINT "auth_challenges_kind_check";--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_kind_check" CHECK ("auth_challenges"."kind" IN ('webauthn_registration', 'webauthn_assertion', 'webauthn_app_step_up', 'second_factor_login', 'account_deletion_email_code', 'data_export_email_code')) NOT VALID;
