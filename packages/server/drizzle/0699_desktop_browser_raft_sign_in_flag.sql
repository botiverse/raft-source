-- Sign in with Raft in Raft Desktop's built-in browser (security design B,
-- Tenny 2026-11-13): a page there that sends the person to Raft's authorize
-- address gets Raft's consent in the app's own window, and no second Raft
-- sign-in. Web (desktop renderer) only: it arms the desktop shell; the server
-- stores and evaluates the flag and reads it nowhere. Server-scoped, default
-- off, no rules: off everywhere until FFA adds an allow rule (/raft first).
-- Off, the desktop app stops that navigation, as before.
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
	'desktop_browser_raft_sign_in_v0',
	'Desktop browser Raft sign-in: Sign in with Raft on a page of Raft Desktop''s built-in browser shows the consent in the app''s own window',
	true,
	false,
	'server',
	false,
	NULL,
	'desktop_browser_raft_sign_in_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
