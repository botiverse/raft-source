-- Superseded by 0100_joint_storage_legacy_convert.
--
-- This migration used to archive early joint-channel rows whose canonical
-- channel was also a real server-local projection. Current production has
-- valuable active data in that shape, so the drain must be a no-op. The
-- conversion migration runs after servers.kind exists and moves active legacy
-- storage into the reserved joint_storage namespace without reopening rows
-- that were already archived by older environments.
SELECT 1;
