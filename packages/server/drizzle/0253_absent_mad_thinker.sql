ALTER TABLE "channels" ADD COLUMN "guest_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "guest_joinable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_guest_joinable_requires_visible" CHECK (NOT "channels"."guest_joinable" OR "channels"."guest_visible");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key", "description", "enabled", "kill_switch", "randomization_unit",
	"default_enabled", "default_variant", "salt"
) VALUES (
	'server_guest_v0',
	'Server Guest role and channel guest visibility/joinability behavior',
	true, false, 'server', false, NULL, 'server_guest_v0'
) ON CONFLICT ("key") DO NOTHING;
