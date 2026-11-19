-- Activity inbox redesign, step 2 (#triage:#244, Tenny): with it on, the web
-- keeps each Activity row by the per-row position rule (shared
-- activityRowPosition.ts and activityUnreadPredicate.ts): a live message on a
-- listed row is applied, ignored or answered by a re-read of that one row
-- (GET /api/channels/inbox?ids=), never of the list; an answer never
-- overwrites a newer row. Web only: the server stores and evaluates the flag
-- and reads it nowhere. Server-scoped, default off, no rules: off everywhere
-- until a human approves an allow rule. Off, the web behaves as before.
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
	'inbox_row_position_v1',
	'Activity: each row follows the per-row position rule; a live message re-reads at most that row, #244 step 2',
	true,
	false,
	'server',
	false,
	NULL,
	'inbox_row_position_v1',
	false
) ON CONFLICT ("key") DO NOTHING;
