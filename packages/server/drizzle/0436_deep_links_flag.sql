-- Deep links v1 (#proj-mobile): the in-app browser guide, the desktop-browser
-- "Open in Raft Desktop" banner, the How links open setting and the shared
-- "Message not found" landing. Server-scoped, default off: the web stays as it
-- is until FFA adds an allow rule. Answerable before login, so the guide on a
-- signed-out page in WeChat can follow the flag once FFA turns it on globally
-- (a before-login read only sees platform rules and default_enabled).
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
	'deep_links_v1',
	'Deep links v1: in-app browser guide, desktop-browser Open in Raft Desktop banner, How links open setting, Message not found landing',
	true,
	false,
	'server',
	false,
	NULL,
	'deep_links_v1',
	true
) ON CONFLICT ("key") DO NOTHING;
