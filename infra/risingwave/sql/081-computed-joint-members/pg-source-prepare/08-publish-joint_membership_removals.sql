-- PG source preparation, not RisingWave DDL or a server migration.
-- Existing authorized operator only, after target/role/publication review.
-- psql -X -v ON_ERROR_STOP=1 -v cdc_role=... -v publication=... -f <this file>
-- One reviewed change per invocation; save pre/post catalog receipts.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
-- Stop if already published: review the existing column set/row filter;
-- do not drop, replace or silently widen an existing publication entry.
ALTER PUBLICATION :"publication" ADD TABLE public.joint_membership_removals (id, departure_id, user_id, remove_membership);
COMMIT;
