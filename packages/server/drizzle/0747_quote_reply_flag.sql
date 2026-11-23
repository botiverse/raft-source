-- Quote Reply v0 (#proj-chat:#34): same-conversation clickable/jumpable quote
-- replies stored inline in message Markdown (`> <excerpt>\n> msg=<8-char-id>`).
-- Server-scoped, default off in production (auto-on in staging via
-- FEATURE_FLAGS_DEFAULT_ON=true). Off: server omits per-reader resolvedQuotes
-- and web keeps legacy plain `> ...` text-selection quoting.
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
	'quote_reply_v0',
	'Quote Reply v0: same-conversation clickable/jumpable inline quote blocks with per-reader server verification',
	true,
	false,
	'server',
	false,
	NULL,
	'quote_reply_v0'
) ON CONFLICT ("key") DO NOTHING;
