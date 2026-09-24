ALTER TABLE "users" ADD COLUMN "profile_setup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_setup_suggested_handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_role" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_survey_completed_at" timestamp with time zone;--> statement-breakpoint
-- Grandfather backfill (identity setup): every pre-migration user already has a
-- finalized handle + display name, so their identity setup IS complete. Mark them so,
-- or they get dragged back through it. New users default to NULL and must complete it.
UPDATE "users" SET "profile_setup_completed_at" = now() WHERE "profile_setup_completed_at" IS NULL;--> statement-breakpoint
-- Grandfather backfill (signup survey), and only for accounts that actually finished
-- onboarding. The gate fires on `signup_survey_completed_at IS NULL`, so both extremes
-- are wrong: no backfill drags long-standing users back through a signup question years
-- later, and a blanket backfill silently skips someone who registered but never picked a
-- handle — they are still mid-onboarding, and should be asked.
UPDATE "users"
SET "signup_survey_completed_at" = now()
WHERE "signup_survey_completed_at" IS NULL
  AND "profile_setup_completed_at" IS NOT NULL;
