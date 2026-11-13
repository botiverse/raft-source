-- Channel announcements (#proj-chat:#29): an announcement can't be hidden
-- ("a pin is a pin", tygg with Kirby, 2026-11-10), so the per-person "hide
-- until the next update" table from channel_announcement goes.
--
-- One step (Tenny, #proj-chat:#29): channel_announcement_hides was added on
-- staging only and never shipped to production, so no serving or rollback
-- image reads or writes it, and it holds no data anyone keeps. Nothing
-- depends on it (no view, no trigger, no RisingWave mirror), so no CASCADE.
--
-- Dropping it drops its foreign keys to users and channels, which takes a
-- short lock on those hot tables for the catalog change: give up after 2 s
-- rather than queue reads behind a long transaction (the deploy runner
-- retries), like channel_announcement did.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DROP TABLE "channel_announcement_hides";
