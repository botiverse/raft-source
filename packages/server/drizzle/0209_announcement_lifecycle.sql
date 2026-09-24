CREATE TABLE "announcement_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"announcement_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_announcements_published_at_desc";--> statement-breakpoint
ALTER TABLE "announcements" ALTER COLUMN "published_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "default_locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "localized_content" json DEFAULT '{}'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "published_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_onboarding_completed_session_family_id" uuid;--> statement-breakpoint
WITH "ranked_legacy_announcements" AS (
	SELECT
		"id",
		row_number() OVER (
			ORDER BY "published_at" DESC, "created_at" DESC, "id" DESC
		) AS "legacy_rank"
	FROM "announcements"
	WHERE "published_at" IS NOT NULL
)
UPDATE "announcements" AS "a"
SET
	"status" = CASE
		WHEN "ranked"."legacy_rank" = 1 THEN 'published'
		ELSE 'expired'
	END,
	"starts_at" = "a"."published_at",
	"activated_at" = "a"."published_at",
	"localized_content" = json_build_object(
		'en',
		json_build_object('title', "a"."title", 'pages', "a"."pages")
	)
FROM "ranked_legacy_announcements" AS "ranked"
WHERE "a"."id" = "ranked"."id";--> statement-breakpoint
WITH "legacy_completion_facts" AS (
	SELECT
		"u"."id" AS "user_id",
		COALESCE(
			MIN("sm"."setup_handoff_acknowledged_at"),
			"u"."profile_setup_completed_at"
		) AS "completed_at"
	FROM "users" AS "u"
	LEFT JOIN "server_members" AS "sm"
		ON "sm"."user_id" = "u"."id"
		AND "sm"."setup_handoff_acknowledged_at" IS NOT NULL
	WHERE "u"."first_onboarding_completed_at" IS NULL
	GROUP BY "u"."id", "u"."profile_setup_completed_at"
)
UPDATE "users" AS "u"
SET "first_onboarding_completed_at" = "facts"."completed_at"
FROM "legacy_completion_facts" AS "facts"
WHERE "u"."id" = "facts"."user_id"
	AND "facts"."completed_at" IS NOT NULL
	AND "u"."first_onboarding_completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD CONSTRAINT "announcement_audit_events_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD CONSTRAINT "announcement_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_announcement_audit_events_announcement_created" ON "announcement_audit_events" USING btree ("announcement_id","created_at");--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_announcements_status_starts_at_desc" ON "announcements" USING btree ("status","starts_at");
