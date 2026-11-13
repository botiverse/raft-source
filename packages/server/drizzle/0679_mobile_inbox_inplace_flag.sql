-- Mobile Activity inbox in place (#triage:#245, Lagoon): with it on, the
-- mobile client updates Activity rows in place and reconciles with an inbox
-- read sent as fetch_reason `inplace_reconcile`. Mobile only: the server
-- stores and evaluates the flag and reads it nowhere. User-scoped (evaluated
-- per user, so FFA can open it for internal users only), default off, no
-- rules: off for everyone until a human approves an allow rule. Off, mobile
-- keeps re-reading the inbox as before.
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
	'mobile_inbox_inplace_v0',
	'Mobile Activity: update inbox rows in place and reconcile with an inplace_reconcile read, #245',
	true,
	false,
	'user',
	false,
	NULL,
	'mobile_inbox_inplace_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
