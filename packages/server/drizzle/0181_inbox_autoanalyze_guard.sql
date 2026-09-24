-- Keep planner statistics for the Inbox serving join ahead of the modification
-- volume that caused the 2026-07-18 plan flip. These are storage parameters
-- only: the migration does not run ANALYZE or mutate application data.
ALTER TABLE "inbox_serving_rows" SET (
	autovacuum_analyze_scale_factor = 0.02,
	autovacuum_analyze_threshold = 2000
);
--> statement-breakpoint
ALTER TABLE "channels" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 2000
);
--> statement-breakpoint
ALTER TABLE "thread_follows" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 5000
);
--> statement-breakpoint
ALTER TABLE "user_channel_read_cursors" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 2000
);
--> statement-breakpoint
ALTER TABLE "channel_humans" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 2000
);
--> statement-breakpoint
ALTER TABLE "messages" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 10000
);
--> statement-breakpoint
ALTER TABLE "message_mentions" SET (
	autovacuum_analyze_scale_factor = 0.05,
	autovacuum_analyze_threshold = 10000
);
