-- agents_assistant_not_on_machine, part 2 of 2: validate the CHECK the
-- previous migration added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE
-- EXCLUSIVE on agents: it scans (~92k rows, ~66 MB) while reads, inserts and
-- updates continue, in its own deploy transaction after part 1's ACCESS
-- EXCLUSIVE lock is released. Production check before deploy (a replica
-- showed 0):
--   SELECT count(*) FROM agents WHERE assistant_owner_user_id IS NOT NULL AND daemon_id IS NOT NULL;   -- expect 0
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_assistant_not_on_machine";
