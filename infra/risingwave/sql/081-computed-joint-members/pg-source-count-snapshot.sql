-- Read-only PostgreSQL counts for the six CDC tables built by 081 steps 01-06.
-- Run as the existing authorized PG operator, never the service login or the
-- new monitoring role. Example with an already configured psql connection:
--   psql -X --set=ON_ERROR_STOP=1 --file=pg-source-count-snapshot.sql
-- Keep the complete output, start/end UTC times, commit SHA and file hash.
-- All six counts share ONE PG snapshot; each statement has a 30-second limit.
-- Require all six labeled count rows AND successful COMMIT; a partial/failed
-- run is incomplete. Zero is an actual count, not a substitute for a failure.
-- Run before and after the RW comparison; matching counts do not establish a
-- common cross-database snapshot or detect same-count edits. See the sampling
-- protocol in docs/operations/rw-joint-members-staging-validation.md.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

-- The first SELECT fixes the snapshot also used by every following SELECT.
-- This PG snapshot id is diagnostic metadata, NOT an RW CDC/WAL fence.
SELECT statement_timestamp() AS snapshot_acquired_at,
       pg_current_snapshot()::text AS pg_snapshot,
       current_setting('transaction_isolation') AS transaction_isolation,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT 'public.joint_channel_members' AS pg_table,
       'rw_joint_channel_members_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.joint_channel_members;

SELECT 'public.joint_channel_admissions' AS pg_table,
       'rw_joint_channel_admissions_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.joint_channel_admissions;

SELECT 'public.joint_membership_departures' AS pg_table,
       'rw_joint_membership_departures_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.joint_membership_departures;

SELECT 'public.joint_membership_removals' AS pg_table,
       'rw_joint_membership_removals_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.joint_membership_removals;

SELECT 'public.server_members' AS pg_table,
       'rw_joint_entry_server_members_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.server_members;

SELECT 'public.joint_channel_servers' AS pg_table,
       'rw_joint_entry_projections_v1' AS rw_table,
       statement_timestamp() AS statement_started_at,
       COUNT(*) AS row_count
FROM public.joint_channel_servers;

SELECT clock_timestamp() AS counts_finished_at,
       pg_current_snapshot()::text AS pg_snapshot;
COMMIT;
