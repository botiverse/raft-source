-- schema-snapshot: unchanged (retire the legacy capture trigger and function)
-- Acquire the binding's final DDL lock up front. Other paths can read bindings
-- before locking an install, so this order can still deadlock; PostgreSQL rolls
-- back a victim transaction. Each lock wait and statement has its own limit,
-- not a single limit for the transaction through commit.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- EXCLUSIVE (rather than SHARE ROW EXCLUSIVE) also conflicts with a writer's
-- SELECT FOR UPDATE / ROW SHARE lock before it reaches the binding table.
LOCK TABLE external_app_installs IN EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE external_channel_bindings IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE external_app_registrations IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE slack_channel_deletions IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  invalid_bindings bigint;
  backfilled_bindings bigint;
  previously_covered_bindings bigint;
  inserted_facts bigint;
BEGIN
  -- A bad identity would lose the old-state proof when the reader changes.
  -- Report only the count and roll the entire migration back in that case.
  SELECT count(*) INTO invalid_bindings
  FROM external_channel_bindings b
  LEFT JOIN external_app_installs i ON i.id = b.install_id
  LEFT JOIN external_app_registrations r ON r.id = b.registration_id
  WHERE b.state = 'paused' AND b.state_reason = 'provider_channel_deleted'
    AND (r.id IS NULL OR i.id IS NULL OR r.provider IS DISTINCT FROM 'slack'
      OR r.environment IS NULL OR r.environment NOT IN ('test', 'production')
      OR i.registration_id IS DISTINCT FROM b.registration_id
      OR i.provider_app_id IS DISTINCT FROM r.provider_app_id
      OR coalesce(length(btrim(i.provider_app_id)), 0) NOT BETWEEN 1 AND 160
      OR coalesce(length(btrim(i.provider_authority_id)), 0) NOT BETWEEN 1 AND 160
      OR coalesce(length(btrim(b.provider_conversation_id)), 0) NOT BETWEEN 1 AND 160);
  IF invalid_bindings > 0 THEN
    RAISE EXCEPTION 'Slack deletion retirement: invalid binding identities=%', invalid_bindings;
  END IF;

  -- Several historical bindings can describe the same scope. Insert one fact
  -- for each previously unrecorded scope, while reporting counts per binding.
  WITH candidates AS MATERIALIZED (
    SELECT b.id AS binding_id, b.binding_epoch, b.updated_at, b.registration_id,
      r.environment, i.provider_app_id, i.provider_authority_id,
      b.provider_conversation_id, i.id AS source_install_id,
      EXISTS (SELECT 1 FROM slack_channel_deletions d
        WHERE d.registration_id = b.registration_id AND d.environment = r.environment
          AND d.provider_app_id = i.provider_app_id AND d.provider_authority_id = i.provider_authority_id
          AND d.provider_conversation_id = b.provider_conversation_id) AS already_recorded
    FROM external_channel_bindings b
    JOIN external_app_installs i ON i.id = b.install_id
    JOIN external_app_registrations r ON r.id = b.registration_id
    WHERE b.state = 'paused' AND b.state_reason = 'provider_channel_deleted'
  ), missing_scopes AS (
    SELECT DISTINCT ON (registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id)
      * FROM candidates WHERE NOT already_recorded
    ORDER BY registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id, binding_id
  ), inserted AS (
    INSERT INTO slack_channel_deletions (
      id, registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id,
      source_install_id, source_kind, source_key, source_binding_id, observed_at
    )
    SELECT gen_random_uuid(), registration_id, environment, provider_app_id, provider_authority_id,
      provider_conversation_id, source_install_id, 'legacy_binding',
      'binding:' || binding_id::text || ':' || binding_epoch::text, binding_id, updated_at
    FROM missing_scopes
    RETURNING id
  )
  SELECT (SELECT count(*) FROM candidates WHERE NOT already_recorded),
    (SELECT count(*) FROM candidates WHERE already_recorded), (SELECT count(*) FROM inserted)
  INTO backfilled_bindings, previously_covered_bindings, inserted_facts;

  DROP TRIGGER IF EXISTS capture_legacy_slack_channel_deletion ON external_channel_bindings;
  DROP FUNCTION IF EXISTS capture_legacy_slack_channel_deletion();
  -- The deploy client buffers this exact numeric notice and reports it only
  -- after Drizzle confirms the enclosing transaction committed.
  RAISE NOTICE 'MIGRATION_REPORT migration=slack_deletion_capture_retirement backfilled_bindings=% previously_covered_bindings=% inserted_facts=%',
    backfilled_bindings, previously_covered_bindings, inserted_facts;
END;
$$;
