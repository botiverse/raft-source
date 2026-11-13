-- Web preview (stdrc, #proj-workspace:a351cd82): a card message's Button with
-- open "beside" opens its page beside the conversation, in a sandboxed frame
-- in the channel's side area. Web only: the server stores and evaluates the
-- flag and reads it nowhere. Server-scoped, default off, no rules: off
-- everywhere until FFA adds an allow rule. Off, card buttons open a new tab.
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
	'web_preview_v0',
	'Web preview: a card button with open beside opens its page in a panel beside the conversation',
	true,
	false,
	'server',
	false,
	NULL,
	'web_preview_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
