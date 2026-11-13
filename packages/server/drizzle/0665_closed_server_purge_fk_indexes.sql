-- Indexes for the foreign keys the closed-server purge's server_rows step
-- (services/closedServerPurgeFinish.ts) makes Postgres check: deleting a row
-- of a table it clears runs, per referencing table, `... WHERE <col> = $1`
-- for that key's ON DELETE action, and none of these columns led an index,
-- so each deleted row scanned the referencing table:
--   tasks(resource_expiry_followup_id), set rows only       NO ACTION, reminders
--   workflow_instances(template_id)                         RESTRICT, workflow_templates
--   reminder_source_acknowledgements(reminder_id)           CASCADE, reminders
--   reminder_source_acknowledgements(source_event_id)       CASCADE, reminder_events
--   agent_runtime_provisions(credential_id), set rows only  SET NULL, agent_credentials
--   sso_auth_transactions(connection_id)                    CASCADE, server_sso_connections
-- and app_agent_messages(agent_id), the column the step deletes by.
-- closedServerPurgeClassification.db.test.ts requires an index on every
-- column that references a table the step clears.
--
-- Like 0659: built here only on a tiny table (tests, dev), by physical size.
-- On a larger one the migration only notes it, and db:migrate:deploy then runs
--   pnpm --filter @botiverse/raft-server db:create-device-session-key-indexes
-- (CREATE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready;
-- scripts/device-session-key-indexes.ts) before the post-migration index guard.
-- Additive only: until an index is built, a delete scans as before.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.tasks'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_tasks_resource_expiry_followup" ON "tasks" USING btree ("resource_expiry_followup_id") WHERE resource_expiry_followup_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'tasks is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_tasks_resource_expiry_followup';
  END IF;
  IF pg_relation_size('public.workflow_instances'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_workflow_instances_template" ON "workflow_instances" USING btree ("template_id");
  ELSE
    RAISE NOTICE 'workflow_instances is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_workflow_instances_template';
  END IF;
  IF pg_relation_size('public.reminder_source_acknowledgements'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_reminder_source_acks_reminder" ON "reminder_source_acknowledgements" USING btree ("reminder_id");
  ELSE
    RAISE NOTICE 'reminder_source_acknowledgements is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_reminder_source_acks_reminder';
  END IF;
  IF pg_relation_size('public.reminder_source_acknowledgements'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_reminder_source_acks_source_event" ON "reminder_source_acknowledgements" USING btree ("source_event_id");
  ELSE
    RAISE NOTICE 'reminder_source_acknowledgements is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_reminder_source_acks_source_event';
  END IF;
  IF pg_relation_size('public.agent_runtime_provisions'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_agent_runtime_provisions_credential" ON "agent_runtime_provisions" USING btree ("credential_id") WHERE credential_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'agent_runtime_provisions is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_agent_runtime_provisions_credential';
  END IF;
  IF pg_relation_size('public.sso_auth_transactions'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_sso_auth_transactions_connection" ON "sso_auth_transactions" USING btree ("connection_id");
  ELSE
    RAISE NOTICE 'sso_auth_transactions is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_sso_auth_transactions_connection';
  END IF;
  IF pg_relation_size('public.app_agent_messages'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_app_agent_messages_agent" ON "app_agent_messages" USING btree ("agent_id");
  ELSE
    RAISE NOTICE 'app_agent_messages is large: run db:create-device-session-key-indexes (CONCURRENTLY) to build idx_app_agent_messages_agent';
  END IF;
END
$$;
