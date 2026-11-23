-- Settled Artifacts (#334; apps/artifacts/settle.ts, README "Settled"): the
-- `artifact_settled_v0` flag row, five nullable columns on
-- `app_artifacts.items` (who settled it, when, at which version, and the
-- version that took it back to Working) and `app_artifacts.settled_holds`
-- (who a held push told of which settle, so the same push again goes through).
--
-- Server-scoped, default off, no rules: while off nothing reads or writes
-- the new columns or table. No backfill: no Artifact is settled before this.
--
-- items is read by every read and push of an Artifact: the columns are
-- catalog-only (nullable, no default: no rewrite, no scan), and both CHECKs
-- are added NOT VALID, so the ACCESS EXCLUSIVE lock is held for catalog
-- changes only, with no scan. They stay NOT VALID with no VALIDATE: every
-- existing row has all five columns NULL, which both accept, and every write
-- from now on is checked. The new table is empty; its foreign key takes a
-- short SHARE ROW EXCLUSIVE lock on items, no scan. Give up after 2 s (the
-- deploy retries) rather than queue reads and pushes behind a long
-- transaction.
--
-- Rolling deploy: an older replica names its own columns, never these, and
-- never settles anything. A push it serves to a settled Artifact isn't held
-- and doesn't mark the settle lapsed (the Artifact reads as still settled at
-- its older version until the next push on new code, or someone unsettles
-- it); with the flag off until the deploy is done, that window is empty.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'artifact_settled_v0',
	'Settled Artifacts: mark an Artifact done (Settled); a new version takes it back to Working',
	true,
	false,
	'server',
	false,
	NULL,
	'artifact_settled_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
CREATE TABLE "app_artifacts"."settled_holds" (
	"item_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settled_holds_item_id_actor_type_actor_id_pk" PRIMARY KEY("item_id","actor_type","actor_id"),
	CONSTRAINT "settled_holds_actor_type" CHECK ("app_artifacts"."settled_holds"."actor_type" IN ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "settled_by_type" text;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "settled_by_id" uuid;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "settled_version_number" integer;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD COLUMN "settled_lapsed_version" integer;--> statement-breakpoint
ALTER TABLE "app_artifacts"."settled_holds" ADD CONSTRAINT "settled_holds_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "app_artifacts"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_settled" CHECK (("app_artifacts"."items"."settled_at" IS NULL AND "app_artifacts"."items"."settled_by_type" IS NULL AND "app_artifacts"."items"."settled_by_id" IS NULL AND "app_artifacts"."items"."settled_version_number" IS NULL) OR ("app_artifacts"."items"."settled_at" IS NOT NULL AND "app_artifacts"."items"."settled_by_type" IN ('user', 'agent') AND "app_artifacts"."items"."settled_by_id" IS NOT NULL AND "app_artifacts"."items"."settled_version_number" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "app_artifacts"."items" ADD CONSTRAINT "items_settled_lapsed" CHECK ("app_artifacts"."items"."settled_lapsed_version" IS NULL OR "app_artifacts"."items"."settled_at" IS NOT NULL) NOT VALID;
