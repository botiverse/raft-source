-- Artifact mini window (#337): in Raft Desktop (a shell with
-- facts.objectWindows), an Artifact opened from the Artifacts home or "Open in
-- new window" opens in an object window of its own (a small native window the
-- main window's web app renders into) instead of the viewer over the page.
-- Web (desktop renderer) only: the server stores and evaluates the flag and
-- reads it nowhere. Server-scoped, default off, no rules (on in staging by the
-- default-on policy). Off, or in a browser: the viewer, as before.
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt",
	"pre_auth_evaluable"
) VALUES (
	'artifact_mini_window_v0',
	'Artifact mini window: in Raft Desktop an Artifact opens in a small window of its own instead of the viewer over the page',
	true,
	false,
	'server',
	false,
	NULL,
	'artifact_mini_window_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
