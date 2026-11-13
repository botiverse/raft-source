-- A "recovery" kind of joint membership source (#wg-rbac:#23, policy v3.1).
-- joint_channel_admissions.kind says how a source row came to be:
-- 'admission' (an ordinary admission; every row so far) or 'recovery' (a
-- source an approved ops recovery restored for a current member). Both count
-- as a live source; neither authorizes anything. joint_admission_recoveries
-- records which ops run wrote a recovery row and under which approval; it
-- goes with its admission row (composite foreign key, ON DELETE CASCADE).
-- An ordinary admission of a live recovery tuple upgrades it to 'admission'
-- (services/jointAdmissionKind.ts); the recovery record stays.
--
-- Part 1 of 2. Catalog-only on joint_channel_admissions: a NOT NULL column
-- with a constant default is not a rewrite (PostgreSQL >= 11 stores the
-- default in the catalog), and the CHECK is added NOT VALID, so nothing is
-- scanned under the ACCESS EXCLUSIVE lock; it binds new and updated rows from
-- now on. The next migration validates it under SHARE UPDATE EXCLUSIVE, which
-- reads and writes don't wait for (as 0469/0470). The new table is empty; its
-- foreign key's SHARE ROW EXCLUSIVE on joint_channel_admissions is already
-- covered by the ALTER above it. No key to a hot table. The lock wait is
-- bounded so a long membership transaction makes the deploy retry instead of
-- queueing joint reads behind it.
--
-- Rolling deploy: an older replica's INSERT ... DO NOTHING writes 'admission'
-- by default and never reads kind. Recovery rows are written only once every
-- replica runs the upgrade-aware writers.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD COLUMN "kind" text DEFAULT 'admission' NOT NULL;--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" ADD CONSTRAINT "joint_channel_admissions_kind_known" CHECK ("joint_channel_admissions"."kind" IN ('admission', 'recovery')) NOT VALID;--> statement-breakpoint
CREATE TABLE "joint_admission_recoveries" (
	"joint_channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"server_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"approval_ref" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "joint_admission_recoveries_joint_channel_id_user_id_generation_server_id_pk" PRIMARY KEY("joint_channel_id","user_id","generation","server_id")
);
--> statement-breakpoint
ALTER TABLE "joint_admission_recoveries" ADD CONSTRAINT "joint_admission_recoveries_admission_fk" FOREIGN KEY ("joint_channel_id","user_id","generation","server_id") REFERENCES "public"."joint_channel_admissions"("joint_channel_id","user_id","generation","server_id") ON DELETE cascade ON UPDATE no action;
