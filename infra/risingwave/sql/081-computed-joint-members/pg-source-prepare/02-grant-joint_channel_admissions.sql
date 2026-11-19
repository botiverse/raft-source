-- PG source preparation, not RisingWave DDL or a server migration.
-- Existing authorized operator only, after target/role/publication review.
-- psql -X -v ON_ERROR_STOP=1 -v cdc_role=... -v publication=... -f <this file>
-- One reviewed change per invocation; save pre/post catalog receipts.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
GRANT SELECT (joint_channel_id, user_id, server_id, generation, ended_at) ON TABLE public.joint_channel_admissions TO :"cdc_role";
COMMIT;
