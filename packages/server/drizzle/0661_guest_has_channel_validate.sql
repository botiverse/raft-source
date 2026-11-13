-- Every Guest has its channel (#wg-rbac:#48, Tenny), step 2 of 2: validate
-- server_members_guest_has_channel, added NOT VALID by 0655 (shipped in
-- v1.21.62, now the oldest image this release can roll back to, and it writes
-- no Guest without a channel).
--   role <> 'guest' OR guest_channel_id IS NOT NULL
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on server_members: it scans
-- while reads, inserts and updates continue, in its own deploy transaction.
-- Production check before deploy, on the primary (a replica showed 0 for 0655):
--   SELECT count(*) FROM server_members WHERE role = 'guest' AND guest_channel_id IS NULL;   -- expect 0
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "server_members" VALIDATE CONSTRAINT "server_members_guest_has_channel";
