-- The continuation pilot (#wg-ax:#5): a held `raft message send` pauses as a
-- continuation (it asks the agent what to do) instead of saving a draft.
-- Server-scoped, default off, no rules: every server keeps the draft flow
-- until FFA adds an allow rule. The Server reports it in the agent context
-- (`features.continuationsPilot`), read by the CLI when a send is held.
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'continuations_pilot_v0',
	'Continuation pilot: a held raft message send asks the agent what to do instead of saving a draft',
	true,
	false,
	'server',
	false,
	NULL,
	'continuations_pilot_v0'
) ON CONFLICT ("key") DO NOTHING;
