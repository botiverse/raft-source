-- Fills oauth_client_uninstalls (previous migration) from the audit log: for
-- each (Server, App), the latest successful uninstall a person made there
-- (`marketplace.uninstalled` / `private_share.uninstalled`, actor_type human;
-- the closed-server purge's are actor_type system and stay out). Skips events
-- whose Server or App is gone, and Servers the closed-server purge has claimed
-- (it deletes these rows with the server's other app rows). A person no longer
-- in users leaves actor_user_id NULL.
--
-- Data only: one INSERT into the new, still empty table. It reads
-- integration_audit_events through idx_integration_audit_event_time (only the
-- two uninstall event types) and servers / oauth_clients / users by primary
-- key: ACCESS SHARE only, which waits for nothing but an ACCESS EXCLUSIVE.
-- The foreign keys were added in their own file so no lock on a hot table is
-- held while this runs.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
INSERT INTO "oauth_client_uninstalls" ("server_id", "client_id", "uninstalled_at", "actor_user_id")
SELECT DISTINCT ON (e."server_id", e."client_id") e."server_id", e."client_id", e."created_at", u."id"
  FROM "integration_audit_events" e
  JOIN "servers" s ON s."id" = e."server_id" AND s."purge_state" IS NULL
  JOIN "oauth_clients" c ON c."id" = e."client_id"
  LEFT JOIN "users" u ON u."id" = e."actor_id"
 WHERE e."event_type" IN ('marketplace.uninstalled', 'private_share.uninstalled')
   AND e."outcome" = 'success'
   AND e."actor_type" = 'human'
   AND e."server_id" IS NOT NULL
   AND e."client_id" IS NOT NULL
 ORDER BY e."server_id", e."client_id", e."created_at" DESC
ON CONFLICT DO NOTHING;
