-- Agent working line (#proj-raft-computer:#40): in a DM, the line above the
-- composer that says an agent is working on your message (what it does now,
-- for how long, its recent steps and its execution record) and the quiet
-- "ended this turn without a reply" row, in DMs only at first (xxchan).
-- Server-scoped, default off, no rules: off everywhere. Enabling it for a
-- server goes through the feature-flag admin API, audited (Tenny adds the
-- staging rule after deploy; production needs xxchan's written go). Off, the
-- web is as before: the typing line, no working-agents reads.
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
	'agent_working_line',
	'Agent working line: in DMs, what the agent is doing on your message, and turns that ended without a reply',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_working_line',
	false
) ON CONFLICT ("key") DO NOTHING;
