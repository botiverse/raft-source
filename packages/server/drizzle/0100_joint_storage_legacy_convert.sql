-- Migrate active legacy joint channels whose canonical_channel_id is also a
-- real server projection into the v2 storage namespace.
--
-- Important boundary:
-- - already-archived/deleted legacy projections are historical artifacts and
--   must stay closed;
-- - active projections keep their local channel ids, membership, unread
--   cursors, and inbox state;
-- - only canonical storage moves to the reserved joint_storage server.

DROP TABLE IF EXISTS _joint_storage_namespace;
--> statement-breakpoint
CREATE TEMP TABLE _joint_storage_namespace (
  id uuid PRIMARY KEY
);
--> statement-breakpoint

INSERT INTO _joint_storage_namespace (id)
SELECT id
  FROM servers
 WHERE slug = '__joint_storage__'
   AND kind = 'joint_storage'
   AND deleted_at IS NULL
 LIMIT 1;
--> statement-breakpoint

INSERT INTO servers (
  id,
  name,
  slug,
  kind,
  owner_id,
  plan,
  agent_all_channel_greeting_enabled,
  created_at,
  updated_at
)
SELECT
  md5(random()::text || clock_timestamp()::text)::uuid,
  'Joint Storage Namespace',
  '__joint_storage__',
  'joint_storage',
  owner_source.owner_id,
  'founder',
  false,
  now(),
  now()
FROM (
  SELECT COALESCE(
    (SELECT created_by_user_id FROM joint_channels WHERE created_by_user_id IS NOT NULL LIMIT 1),
    (SELECT owner_id FROM servers WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)
  ) AS owner_id
) AS owner_source
WHERE owner_source.owner_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM _joint_storage_namespace);
--> statement-breakpoint

INSERT INTO _joint_storage_namespace (id)
SELECT id
  FROM servers
 WHERE slug = '__joint_storage__'
   AND kind = 'joint_storage'
   AND deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DROP TABLE IF EXISTS _joint_storage_migration_map;
--> statement-breakpoint
CREATE TEMP TABLE _joint_storage_migration_map AS
SELECT
  jc.id AS joint_channel_id,
  jc.canonical_channel_id AS old_canonical_channel_id,
  md5(random()::text || clock_timestamp()::text || jc.id::text)::uuid AS new_canonical_channel_id,
  old_c.name AS old_name,
  old_c.description AS old_description,
  old_c.created_at AS old_created_at
FROM joint_channels jc
JOIN joint_channel_servers host_projection
  ON host_projection.joint_channel_id = jc.id
 AND host_projection.local_channel_id = jc.canonical_channel_id
 AND host_projection.status = 'active'
JOIN channels old_c
  ON old_c.id = jc.canonical_channel_id
WHERE jc.status = 'active'
  AND old_c.type = 'joint'
  AND old_c.deleted_at IS NULL
  AND old_c.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM _joint_storage_namespace)
  AND NOT EXISTS (
    SELECT 1
      FROM channels canonical
      JOIN servers canonical_server ON canonical_server.id = canonical.server_id
     WHERE canonical.id = jc.canonical_channel_id
       AND canonical_server.kind = 'joint_storage'
  );
--> statement-breakpoint

INSERT INTO channels (
  id,
  server_id,
  name,
  description,
  type,
  created_at
)
SELECT
  migration.new_canonical_channel_id,
  namespace.id,
  'joint-storage-' || replace(migration.joint_channel_id::text, '-', ''),
  migration.old_description,
  'channel',
  COALESCE(migration.old_created_at, now())
FROM _joint_storage_migration_map migration
CROSS JOIN _joint_storage_namespace namespace;
--> statement-breakpoint

UPDATE messages message
   SET channel_id = migration.new_canonical_channel_id
  FROM _joint_storage_migration_map migration
 WHERE message.channel_id = migration.old_canonical_channel_id;
--> statement-breakpoint

UPDATE attachments attachment
   SET channel_id = migration.new_canonical_channel_id
  FROM _joint_storage_migration_map migration
 WHERE attachment.channel_id = migration.old_canonical_channel_id
   AND attachment.message_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM messages message
      WHERE message.id = attachment.message_id
        AND message.channel_id = migration.new_canonical_channel_id
   );
--> statement-breakpoint

UPDATE joint_channels joint
   SET canonical_channel_id = migration.new_canonical_channel_id,
       updated_at = now()
  FROM _joint_storage_migration_map migration
 WHERE joint.id = migration.joint_channel_id;
--> statement-breakpoint

DROP TABLE IF EXISTS _joint_storage_migration_map;
--> statement-breakpoint
DROP TABLE IF EXISTS _joint_storage_namespace;
