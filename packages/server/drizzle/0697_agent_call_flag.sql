-- Calling an agent from Raft (agent_call_v0, Raft Deck task #228): a phone
-- icon on an agent's profile header and on its DM header opens a small
-- floating window with Raft Deck's call page for that agent (its live voice in
-- a holt-live room). Web only: the server stores and evaluates the flag and
-- reads it nowhere (Deck keeps its own gate, deck.call.servers). Server-scoped,
-- default off, no rules: off everywhere until FFA adds an allow rule. Off, no
-- icon and no window.
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
	'agent_call_v0',
	'Agent call: call an agent from its profile or DM header, Raft Deck live voice in a floating window',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_call_v0',
	false
) ON CONFLICT ("key") DO NOTHING;
