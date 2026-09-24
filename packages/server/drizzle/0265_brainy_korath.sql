ALTER TABLE "servers" ADD COLUMN "publicly_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key", "description", "enabled", "kill_switch", "randomization_unit",
	"default_enabled", "default_variant", "salt"
) VALUES (
	'public_server_v0',
	'Public Server anonymous read surface',
	true, false, 'server', false, NULL, 'public_server_v0'
) ON CONFLICT ("key") DO NOTHING;
