ALTER TABLE "server_members" ADD COLUMN "onboarding_owner_opener_v2_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_owner_opener_v2_sent_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_owner_opener_v2_message_ids" json DEFAULT '[]'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_owner_opener_v2_version" text;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "onboarding_owner_opener_v2_topics" json DEFAULT '[]'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "cross_channel_hint_shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "all_channel_unlock_instruction_sent_at" timestamp with time zone;--> statement-breakpoint
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
	'onboarding_opener_v2',
	'Owner onboarding opener v2 rollout gate; seeds OA-authored opener messages with a durable no-resend ledger',
	true,
	false,
	'server',
	false,
	NULL,
	'onboarding_opener_v2'
) ON CONFLICT ("key") DO NOTHING;