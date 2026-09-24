-- Follow-up for active legacy joint channels created before the global
-- joint_storage namespace existed.
--
-- 0100 converted the earliest shape where canonical_channel_id was also the
-- host local projection. This migration converts the later staging/prod shape
-- where canonical_channel_id is a separate storage channel/thread under the
-- host's real server. Those channels are not product projections either, so
-- message-child resources must move into the reserved joint_storage namespace.

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
  old_c.type AS old_type
FROM joint_channels jc
JOIN channels old_c
  ON old_c.id = jc.canonical_channel_id
WHERE jc.status = 'active'
  AND old_c.type IN ('joint', 'thread')
  AND old_c.deleted_at IS NULL
  AND old_c.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM _joint_storage_namespace)
  AND EXISTS (
    SELECT 1
      FROM joint_channel_servers jcs
     WHERE jcs.joint_channel_id = jc.id
       AND jcs.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM joint_channel_servers local_projection
     WHERE local_projection.joint_channel_id = jc.id
       AND local_projection.local_channel_id = jc.canonical_channel_id
       AND local_projection.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM channels canonical
      JOIN servers canonical_server ON canonical_server.id = canonical.server_id
     WHERE canonical.id = jc.canonical_channel_id
       AND canonical_server.kind = 'joint_storage'
  );
--> statement-breakpoint

UPDATE channels channel
   SET server_id = namespace.id,
       name = 'joint-storage-' || replace(migration.joint_channel_id::text, '-', ''),
       type = CASE WHEN migration.old_type = 'thread' THEN 'thread' ELSE 'channel' END
  FROM _joint_storage_migration_map migration
  CROSS JOIN _joint_storage_namespace namespace
 WHERE channel.id = migration.old_canonical_channel_id;
--> statement-breakpoint

DROP TABLE IF EXISTS _joint_storage_migration_map;
--> statement-breakpoint
DROP TABLE IF EXISTS _joint_storage_namespace;
