-- Raft voice (agent_voice_v1, #wg-runtime-form:#22): a person asks an agent
-- what it is doing now, or asks it one question answered by a read-only fork
-- of its session (POST /api/oauth/agents/:agentId/voice/status and /ask,
-- scope agent:voice; agentVoiceService.ts). Server-scoped, default off, no
-- rules: off everywhere until a human approves an allow rule. Off, both
-- endpoints answer as for an unknown agent.
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
	'agent_voice_v1',
	'Raft voice: ask an agent what it is doing now, or ask it one question, through agent:voice',
	true,
	false,
	'server',
	false,
	NULL,
	'agent_voice_v1',
	false
) ON CONFLICT ("key") DO NOTHING;
