CREATE TABLE "user_channel_display_prefs" (
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"collapse_long_messages" boolean DEFAULT true NOT NULL,
	"prefs_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channel_display_prefs_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "user_channel_display_prefs" ADD CONSTRAINT "user_channel_display_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_display_prefs" ADD CONSTRAINT "user_channel_display_prefs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channel_display_prefs" ADD CONSTRAINT "user_channel_display_prefs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_channel_display_prefs_user" ON "user_channel_display_prefs" USING btree ("server_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_user_channel_display_prefs_channel" ON "user_channel_display_prefs" USING btree ("channel_id");
--> statement-breakpoint
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
	'topbar_overflow_v0',
	'Panel topbar overflow menu redesign (task #187); web-only gate, server allowlist first',
	true,
	false,
	'server',
	false,
	NULL,
	'topbar_overflow_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('botiverse')
		AND "deleted_at" IS NULL
)
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values",
	"percentage_basis_points",
	"variant"
)
SELECT
	'3b741f40-162f-40d1-9cb9-3a1c9d272475',
	'topbar_overflow_v0',
	'server',
	0,
	'allow',
	"server_ids",
	NULL,
	NULL
FROM allowlist
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"updated_at" = now();
