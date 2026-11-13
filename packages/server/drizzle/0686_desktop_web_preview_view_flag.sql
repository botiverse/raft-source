-- Desktop web preview view: in Raft Desktop, the web preview panel
-- (web_preview_v0) shows its page in a real browser view (an Electron
-- WebContentsView in its own session partition) laid over the panel, instead
-- of a sandboxed frame most sites refuse. Web (desktop renderer) only: the
-- server stores and evaluates the flag and reads it nowhere. Server-scoped,
-- default off, no rules: off everywhere until FFA adds an allow rule. Off,
-- the desktop app keeps the frame, as the browser does.
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
	'desktop_web_preview_view_v0',
	'Desktop web preview view: in Raft Desktop the web preview shows its page in a native browser view instead of a frame',
	true,
	false,
	'server',
	false,
	NULL,
	'desktop_web_preview_view_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
