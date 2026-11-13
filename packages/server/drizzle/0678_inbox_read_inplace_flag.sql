-- Activity inbox refresh, step 3a (#triage:#244, Tenny): with it on, a
-- persisted read of a row Activity already lists updates that row in place
-- and sends no GET /api/channels/inbox re-read. Only read_persisted; live
-- messages and thread replies still re-read. Web only: the server stores and
-- evaluates the flag and reads it nowhere. Server-scoped, default off, no
-- rules: off everywhere until a human approves an allow rule. Off, every
-- persisted read re-reads, as before.
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
	'inbox_read_inplace_v1',
	'Activity: a read of a listed row updates the inbox in place without a re-read, #244 step 3a',
	true,
	false,
	'server',
	false,
	NULL,
	'inbox_read_inplace_v1',
	false
) ON CONFLICT ("key") DO NOTHING;
