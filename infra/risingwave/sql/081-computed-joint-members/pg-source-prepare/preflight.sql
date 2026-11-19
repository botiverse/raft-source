-- Read-only source receipt, before and after each approved PG step.
-- psql variables cdc_role and publication are required; no credential values.
-- Require the reviewed existing role and publication, publication not FOR ALL
-- TABLES, all expected columns present, and after preparation each column
-- readable and published, with no unexpected columns or row filter.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT current_database() AS database_name, current_schema() AS schema_name,
       current_setting('server_version_num') AS server_version_num;
SELECT rolname FROM pg_roles WHERE rolname = :'cdc_role';
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
FROM pg_publication WHERE pubname = :'publication';
WITH expected(table_name, column_name) AS (VALUES
    ('joint_channel_members', 'joint_channel_id'),
    ('joint_channel_members', 'user_id'),
    ('joint_channel_members', 'generation'),
    ('joint_channel_members', 'joined_at'),
    ('joint_channel_admissions', 'joint_channel_id'),
    ('joint_channel_admissions', 'user_id'),
    ('joint_channel_admissions', 'server_id'),
    ('joint_channel_admissions', 'generation'),
    ('joint_channel_admissions', 'ended_at'),
    ('joint_membership_departures', 'id'),
    ('joint_membership_departures', 'joint_channel_id'),
    ('joint_membership_departures', 'completed_at'),
    ('joint_membership_removals', 'id'),
    ('joint_membership_removals', 'departure_id'),
    ('joint_membership_removals', 'user_id'),
    ('joint_membership_removals', 'remove_membership')
)
SELECT e.table_name, e.column_name,
       a.attname IS NOT NULL AS column_exists,
       CASE WHEN a.attname IS NOT NULL THEN
         has_column_privilege(:'cdc_role', c.oid, a.attnum, 'SELECT')
       ELSE false END AS readable,
       EXISTS (
         SELECT 1 FROM pg_publication p
         JOIN pg_publication_rel pr ON pr.prpubid=p.oid
         WHERE p.pubname=:'publication' AND pr.prrelid=c.oid
           AND (pr.prattrs IS NULL OR a.attnum=ANY(pr.prattrs::int2[]))
       ) AS published,
       c.relreplident AS replica_identity
FROM expected e
LEFT JOIN pg_namespace n ON n.nspname='public'
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name
LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name
  AND a.attnum>0 AND NOT a.attisdropped
ORDER BY e.table_name, e.column_name;
-- Full column lists: review these, not just the expected-column booleans.
SELECT t.tablename, t.attnames AS published_columns, t.rowfilter
FROM pg_publication_tables t
WHERE t.pubname=:'publication' AND t.schemaname='public'
  AND t.tablename IN ('joint_channel_members','joint_channel_admissions',
                     'joint_membership_departures','joint_membership_removals')
ORDER BY t.tablename;
-- All replica-key columns must be in the reviewed publication column lists.
SELECT c.relname AS table_name, c.relreplident AS replica_identity,
       i.indisprimary AS is_primary_key, i.indisreplident AS is_replica_key,
       pg_get_indexdef(i.indexrelid) AS key_definition
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_index i ON i.indrelid=c.oid
WHERE n.nspname='public' AND (i.indisprimary OR i.indisreplident)
  AND c.relname IN ('joint_channel_members','joint_channel_admissions',
                   'joint_membership_departures','joint_membership_removals')
ORDER BY c.relname, i.indexrelid;
COMMIT;
