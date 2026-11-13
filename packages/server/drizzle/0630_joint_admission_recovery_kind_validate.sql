-- joint_channel_admissions.kind, part 2 of 2: validate the CHECK the previous
-- migration added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE
-- on joint_channel_admissions: it scans while reads, inserts and updates
-- continue, in its own deploy transaction after part 1's ACCESS EXCLUSIVE
-- lock is released. Every existing row has kind 'admission' (the column's
-- default), so it holds. Production check before deploy (after part 1):
--   SELECT count(*) FROM joint_channel_admissions WHERE kind NOT IN ('admission', 'recovery');   -- expect 0
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "joint_channel_admissions" VALIDATE CONSTRAINT "joint_channel_admissions_kind_known";
