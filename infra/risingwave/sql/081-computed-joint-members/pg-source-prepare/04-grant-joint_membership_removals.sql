-- PG source preparation, not RisingWave DDL or a server migration.
-- Existing authorized operator only, after target/role/publication review.
-- psql -X -v ON_ERROR_STOP=1 -v cdc_role=... -v publication=... -f <this file>
-- One reviewed change per invocation; save pre/post catalog receipts.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
GRANT SELECT (id, departure_id, user_id, remove_membership) ON TABLE public.joint_membership_removals TO :"cdc_role";
COMMIT;
