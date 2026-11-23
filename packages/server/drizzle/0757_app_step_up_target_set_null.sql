-- app_login_requests.target_family_id: ON DELETE SET NULL instead of CASCADE
-- (fix-red for 0755_app_web_step_up). session_families is purged from the
-- release-QA seed (scripts/deploy/release-qa-neon-mask-policy.mjs), and a
-- retained child of purged authority must use SET NULL like the other family
-- pointers (approver_family_id). A step_up row whose sign-in is gone matches
-- no family: describe, options, verify and redeem refuse it
-- (services/appStepUpService.ts).
--
-- The step-up target CHECK becomes one-way, so the SET NULL is allowed: a
-- login row never has a target; a step_up row has one from its start and
-- loses it only with its family. The old two-way CHECK would reject the
-- family delete.
--
-- Lock budget as 0755: app_login_requests is small. The foreign key is re-added
-- NOT VALID (SHARE ROW EXCLUSIVE on session_families, no scan) and validated in
-- the same transaction (scans app_login_requests only); the CHECK is added NOT
-- VALID and validated the same way.
--
-- Rolling deploy and rollback: the previous release inserts login rows with a
-- NULL target and step_up rows with one; both pass the new CHECK.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "app_login_requests" DROP CONSTRAINT "app_login_requests_step_up_target_check";--> statement-breakpoint
ALTER TABLE "app_login_requests" DROP CONSTRAINT "app_login_requests_target_family_id_session_families_id_fk";--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_target_family_id_session_families_id_fk" FOREIGN KEY ("target_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "app_login_requests" VALIDATE CONSTRAINT "app_login_requests_target_family_id_session_families_id_fk";--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_step_up_target_check" CHECK ("app_login_requests"."purpose" = 'step_up' OR "app_login_requests"."target_family_id" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "app_login_requests" VALIDATE CONSTRAINT "app_login_requests_step_up_target_check";
