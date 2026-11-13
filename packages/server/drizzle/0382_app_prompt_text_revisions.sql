-- App prompt text revisions (task #4, #proj-apps). An app's name, description
-- and when_to_use go into the system prompt of every agent on a Server that
-- installed it, so each edit becomes an immutable revision and each Server's
-- admin confirms the revision its agents read.
-- Backfill: every existing app gets revision 1 with its current text, and
-- every existing installation and server-local app counts as having confirmed
-- it (decided by yezizp, #proj-apps:1229fd83), so the prompt is unchanged at
-- deploy. Rows written by the previous release between this migration and the
-- new code are healed by scripts/backfill-app-prompt-text-revisions.ts.
-- oauth_clients / oauth_client_installs are small (hundreds of rows); bound the
-- lock wait so a long transaction makes the deploy retry instead of queueing.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "oauth_app_text_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"when_to_use" text,
	"state" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_text_revisions_revision_positive" CHECK ("oauth_app_text_revisions"."revision" > 0),
	CONSTRAINT "oauth_app_text_revisions_state_valid" CHECK ("oauth_app_text_revisions"."state" IN ('active', 'pending_review', 'superseded', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "confirmed_text_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "text_confirmed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "text_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "text_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "text_current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "text_pending_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "local_confirmed_text_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_app_text_revisions" ADD CONSTRAINT "oauth_app_text_revisions_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_text_revisions" ADD CONSTRAINT "oauth_app_text_revisions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_app_text_revisions_client_revision" ON "oauth_app_text_revisions" USING btree ("client_id","revision");--> statement-breakpoint
CREATE INDEX "idx_oauth_app_text_revisions_state" ON "oauth_app_text_revisions" USING btree ("client_id","state");--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_confirmed_text_revision_id_oauth_app_text_revisions_id_fk" FOREIGN KEY ("confirmed_text_revision_id") REFERENCES "public"."oauth_app_text_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_text_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("text_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_text_revision_nonnegative" CHECK ("oauth_clients"."text_revision" >= 0);--> statement-breakpoint
INSERT INTO "oauth_app_text_revisions" ("id", "client_id", "revision", "name", "description", "when_to_use", "state", "created_by_type")
SELECT gen_random_uuid(), "c"."id", 1, "c"."name", "c"."description", "c"."when_to_use", 'active', 'system'
FROM "oauth_clients" AS "c"
WHERE "c"."text_current_revision_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "oauth_app_text_revisions" AS "r" WHERE "r"."client_id" = "c"."id");--> statement-breakpoint
UPDATE "oauth_clients" AS "c" SET
  "text_revision" = 1,
  "text_current_revision_id" = "r"."id",
  "local_confirmed_text_revision_id" = COALESCE("c"."local_confirmed_text_revision_id", "r"."id")
FROM "oauth_app_text_revisions" AS "r"
WHERE "c"."text_current_revision_id" IS NULL AND "r"."client_id" = "c"."id" AND "r"."revision" = 1;--> statement-breakpoint
UPDATE "oauth_client_installs" AS "i" SET
  "confirmed_text_revision_id" = "c"."text_current_revision_id",
  "text_confirmed_at" = now()
FROM "oauth_clients" AS "c"
WHERE "c"."id" = "i"."client_id"
  AND "i"."confirmed_text_revision_id" IS NULL
  AND "i"."text_confirmed_at" IS NULL
  AND "c"."text_current_revision_id" IS NOT NULL;
