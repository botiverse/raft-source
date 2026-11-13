-- The thread a save followed (thread contract D, db/schema.ts thread_follows):
--   user_saved.thread_channel_id  the saver's thread of the saved message,
--                                 written when it is saved; Activity's Saved
--                                 filter lists these threads and unsaving the
--                                 last save linked to one releases a follow
--                                 that only the save started.
-- Nullable, no default, no foreign key: a metadata-only ADD COLUMN. Existing
-- saves stay NULL (no backfill: only saves from now on follow).
ALTER TABLE "user_saved" ADD COLUMN "thread_channel_id" uuid;
