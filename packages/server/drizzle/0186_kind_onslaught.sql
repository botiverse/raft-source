ALTER TABLE "product_events" DROP CONSTRAINT "product_events_subject_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" DROP CONSTRAINT "product_events_event_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_subject_type_whitelist" CHECK ("product_events"."subject_type" IN ('action_card', 'onboarding_wizard', 'server'));--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_event_type_whitelist" CHECK ("product_events"."event_type" IN (
      'action_card.open',
      'action_card.dismiss',
      'action_card.execute_attempt',
      'action_card.execute_success',
      'action_card.execute_fail',
      'action_card.expired',
      'onboarding_wizard.step_shown',
      'onboarding_wizard.primary_clicked',
      'onboarding_wizard.skip_clicked',
      'onboarding_wizard.dismissed',
      'onboarding_wizard.completed',
      'onboarding_wizard.error',
      'agent.second_created'
    ));--> statement-breakpoint
-- Backfill only rows whose immutable creator attribution can prove that the
-- second-ever agent in the server was created by a human. Older agents from
-- before creator_type/creator_id coverage intentionally remain absent rather
-- than being guessed from current ownership or membership.
WITH ranked_agents AS (
  SELECT
    id,
    server_id,
    creator_id,
    creator_type,
    created_at,
    row_number() OVER (PARTITION BY server_id ORDER BY created_at, id) AS agent_ordinal
  FROM agents
)
INSERT INTO product_events (
  id,
  subject_type,
  subject_id,
  event_type,
  actor_type,
  actor_id,
  occurred_at,
  metadata,
  schema_version,
  source,
  idempotency_key
)
SELECT
  gen_random_uuid(),
  'server',
  server_id,
  'agent.second_created',
  'human',
  creator_id,
  created_at,
  jsonb_build_object(
    'agent_id', id,
    'agent_ordinal', 2,
    'scope', 'server',
    'capture_mode', 'backfill',
    'writer', 'migration_0186'
  ),
  1,
  'migration',
  'server-second-agent-created-v1'
FROM ranked_agents
WHERE agent_ordinal = 2
  AND creator_type = 'user'
  AND creator_id IS NOT NULL
ON CONFLICT DO NOTHING;
