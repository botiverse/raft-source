-- A device session a Computer retired once it had its own key (device-auth
-- design v2 §4 step 2, POST /api/computer/retire-session): its tokens stop
-- authenticating and refreshing, but its keys keep naming the family, so a
-- later revoke still revokes them.
--
-- Two nullable columns with no default: no table rewrite, no scan. The
-- ACCESS EXCLUSIVE lock on session_families is held for these two statements
-- only, with no other lock taken in this migration.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "retired_reason" text;
