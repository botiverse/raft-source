-- Retired Wiki, step 5 of 6 (0606 is now a no-op; its comment names 0610-0614, but #13078 took 0610 first): the Wiki tables' foreign keys
-- to users, dropped on their own so that this is the only step that locks users.
-- 0615 then drops the five tables without touching any table code uses.
--
-- Locks: ACCESS EXCLUSIVE on each Wiki table named (no code reads or writes them since
-- #8221) and ACCESS EXCLUSIVE on users, for removing the foreign keys' triggers there
-- (as 0599 measured): every users read and write waits while it is held or waited for.
-- So no other hot table is locked here, the wait is at most 2 s (the deploy runner
-- retries a lock timeout) and the lock is kept only for the catalog change.
--
-- Where 0606's first version already dropped the tables (staging), ALTER TABLE IF EXISTS
-- takes no lock and does nothing.
--
-- schema-snapshot: unchanged (schema.ts no longer declares the Wiki tables)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE IF EXISTS "wiki_spaces" DROP CONSTRAINT IF EXISTS "wiki_spaces_created_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE IF EXISTS "wiki_bindings" DROP CONSTRAINT IF EXISTS "wiki_bindings_created_by_user_id_users_id_fk";
