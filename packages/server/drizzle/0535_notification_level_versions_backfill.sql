-- Unified notifications, contract step 1 (see notification_outbox_contract).
-- This one: copies server_members.notification_prefs_version, the legacy
-- level counter, into user_notification_level_versions (migration
-- notification_level_versions), so the counter is never below it and a later
-- step can stop reading the column and then drop it. This release stops
-- writing the column (services/notifications/settings.ts bumpPrefsVersion);
-- reads still take GREATEST(counter, column).
--
-- Why the counter stays at or above the column from here on: after this
-- statement every (user, server) with a nonzero column value has a counter
-- row >= it; v1.21.43 (beside this release in the canary, and its rollback
-- image) writes the same value to both in one transaction, and this release
-- writes only the counter. A v1.21.43 write racing this statement commits
-- both values together, so either value this statement reads is covered.
--
-- Idempotent: a counter already at or above the column is left as it is (the
-- WHERE on DO UPDATE), and running it again changes nothing. Only rows with a
-- nonzero column are copied (0 is the default; no counter row reads as 0).
--
-- Locks: a read of server_members (ACCESS SHARE, waits for no writer) and an
-- upsert into user_notification_level_versions (ROW EXCLUSIVE plus the rows it
-- writes). server_members.user_id references users, so every row satisfies
-- the counter's users foreign key; its check takes KEY SHARE on those users
-- rows, which lock_timeout bounds. One pass over server_members, well inside
-- statement_timeout.
--
-- schema-snapshot: unchanged (data only)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
INSERT INTO "user_notification_level_versions" ("user_id", "server_id", "version", "updated_at")
SELECT "user_id", "server_id", "notification_prefs_version", now()
  FROM "server_members"
 WHERE "notification_prefs_version" > 0
ON CONFLICT ("user_id", "server_id") DO UPDATE
   SET "version" = EXCLUDED."version",
       "updated_at" = now()
 WHERE "user_notification_level_versions"."version" < EXCLUDED."version";
