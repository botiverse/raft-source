CREATE TABLE "feature_flag_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flag_key" text NOT NULL,
	"stage" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"decision" text NOT NULL,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"percentage_basis_points" integer,
	"variant" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flag_rules_stage_valid" CHECK ("feature_flag_rules"."stage" IN ('user', 'server', 'plan', 'percentage')),
	CONSTRAINT "feature_flag_rules_decision_valid" CHECK ("feature_flag_rules"."decision" IN ('allow', 'deny')),
	CONSTRAINT "feature_flag_rules_percentage_valid" CHECK ("feature_flag_rules"."percentage_basis_points" IS NULL OR ("feature_flag_rules"."percentage_basis_points" >= 0 AND "feature_flag_rules"."percentage_basis_points" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"randomization_unit" text NOT NULL,
	"default_enabled" boolean DEFAULT false NOT NULL,
	"default_variant" text,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_randomization_unit_valid" CHECK ("feature_flags"."randomization_unit" IN ('user', 'server'))
);
--> statement-breakpoint
ALTER TABLE "feature_flag_rules" ADD CONSTRAINT "feature_flag_rules_flag_key_feature_flags_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flags"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feature_flag_rules_flag" ON "feature_flag_rules" USING btree ("flag_key");--> statement-breakpoint
CREATE INDEX "idx_feature_flag_rules_flag_stage_priority" ON "feature_flag_rules" USING btree ("flag_key","stage","priority");--> statement-breakpoint
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
	'attachment_comments_v0',
	'Attachment comments MVP backend/web gate',
	true,
	false,
	'server',
	true,
	NULL,
	'attachment_comments_v0'
);
