-- Activity inbox refresh, step 3b (#triage:#244, Tenny): with it on, a live
-- message or thread reply on a row Activity already lists, patched in place
-- (order, unread, mention, preview), sends no GET /api/channels/inbox re-read.
-- Only message_new and thread_reply; persisted reads are step 3a
-- (inbox_read_inplace_v1). Web only: the server stores and evaluates the flag
-- and reads it nowhere. Server-scoped, default off, no rules: off everywhere
-- until a human approves an allow rule. Off, every live message re-reads, as
-- before.
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
	'inbox_message_inplace_v1',
	'Activity: a live message on a listed row updates the inbox in place without a re-read, #244 step 3b',
	true,
	false,
	'server',
	false,
	NULL,
	'inbox_message_inplace_v1',
	false
) ON CONFLICT ("key") DO NOTHING;
