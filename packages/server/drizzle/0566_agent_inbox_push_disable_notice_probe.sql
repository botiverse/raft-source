-- Inbox push registrations that stop (disabled_at) are no longer silent and no
-- longer permanent (#proj-assistant:742b8915; agentInboxPushService.ts):
--   - last_disabled_notice_at: the owner's notice that pushes stopped, claimed
--     in the UPDATE that sets disabled_at (one notice per 24 hours);
--   - first_unauthorized_at / consecutive_unauthorized: the current run of
--     401s, which disables at 3 or more 401s spanning 24 hours instead of
--     counting toward the 3 rejections;
--   - next_probe_at / probe_backoff_ms: the recovery probe of an
--     endpoint_rejected registration (1 hour, doubling, capped at 24 hours);
--   - probe_stopped_at: probing gave up after 30 days stopped; only a new PUT
--     (which clears it) resumes delivery.
-- No backfill: an endpoint_rejected row with next_probe_at NULL (stopped
-- before this, or by an older replica during the deploy) is due at once.
-- Nullable adds and a constant default are metadata only, under a short lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "last_disabled_notice_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "first_unauthorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "consecutive_unauthorized" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "next_probe_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "probe_backoff_ms" integer;--> statement-breakpoint
ALTER TABLE "agent_inbox_push_registrations" ADD COLUMN "probe_stopped_at" timestamp with time zone;
