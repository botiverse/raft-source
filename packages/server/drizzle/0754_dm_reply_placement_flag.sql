-- DM reply placement prompt (#triage:#540): on a server with task
-- conversations, an agent's standing prompt adds that in a DM with one person
-- it confirms taking work, asks what it needs and sends the result on the
-- DM's own timeline, not in a thread or the task's conversation. Prompt text
-- only. Server-scoped, default off, no rules: every agent keeps today's
-- prompt until FFA adds an allow rule for a server. The Server sends it on
-- `agent:start` (`AgentConfig.dmReplyPlacement`) and reads it for an external
-- agent's guide (`GET /context`).
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
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
	'dm_reply_placement_prompt',
	'DM reply placement prompt: in a DM with one person, agents confirm and report on the DM timeline, not in a thread or the task conversation',
	true,
	false,
	'server',
	false,
	NULL,
	'dm_reply_placement_prompt'
) ON CONFLICT ("key") DO NOTHING;
