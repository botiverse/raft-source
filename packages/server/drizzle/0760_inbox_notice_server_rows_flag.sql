-- The wake-up notice with the Server's unread numbers (#wg-ax:#42): before it
-- prints a notice, an agent's Computer asks the Server for the `inbox check`
-- rows of the conversations it is about to list (`POST /inbox/rows`) and
-- prints the Server's numbers. Server-scoped, default off, no rules: every
-- Computer keeps today's notice and asks nothing until FFA adds an allow rule
-- for a server. The Server sends it on `agent:start` and `server:features`
-- (`AgentConfig.inboxNoticeServerRows`); the Computer reads it at each notice.
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
	'inbox_notice_server_rows_v0',
	'Wake-up notice with the Server''s unread numbers: the Computer asks the Server for the rows it is about to list',
	true,
	false,
	'server',
	false,
	NULL,
	'inbox_notice_server_rows_v0'
) ON CONFLICT ("key") DO NOTHING;
