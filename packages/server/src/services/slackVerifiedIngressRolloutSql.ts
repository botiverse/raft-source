/** Append to the coordinated W4 migration after its table definitions. Never run at server startup. */
export const SLACK_INGRESS_ROW_FENCE_BODY = `
DECLARE required_protocol integer;
BEGIN
  IF TG_TABLE_NAME = 'external_inbound_events' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.provider <> 'slack' THEN RETURN NEW; END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.provider <> 'slack' THEN RETURN OLD; END IF;
    ELSE
      IF OLD.provider <> 'slack' AND NEW.provider <> 'slack' THEN RETURN NEW; END IF;
    END IF;
  END IF;
  -- A locking read cannot silently use a pre-activation REPEATABLE READ snapshot.
  SELECT minimum_writer_protocol INTO required_protocol
    FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Slack ingress protocol state missing' USING ERRCODE = '55000'; END IF;
  IF required_protocol > 0 AND current_setting('raft.slack_ingress_protocol', true)
    IS DISTINCT FROM required_protocol::text THEN
    RAISE EXCEPTION 'Slack ingress writer protocol required' USING ERRCODE = '55000';
  END IF;
  IF required_protocol > 0 AND TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'slack_verified_ingress_events' THEN
      IF OLD.state NOT IN ('completed', 'discarded') THEN
        RAISE EXCEPTION 'Unresolved Slack receipt cannot be removed' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.status NOT IN ('committed', 'duplicate', 'echo')
      AND NOT (OLD.status = 'dead' AND OLD.outcome_reason IS NOT DISTINCT FROM 'confirmed_thread_root_missing') THEN
      RAISE EXCEPTION 'Unresolved Slack normalized receipt cannot be removed' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
`;

export const SLACK_INGRESS_POLICY_FENCE_BODY = `
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Slack ingress protocol floor cannot be removed' USING ERRCODE = '55000';
  END IF;
  IF NEW.minimum_writer_protocol < OLD.minimum_writer_protocol OR NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'Slack ingress protocol floor or generation cannot go backwards' USING ERRCODE = '55000';
  END IF;
  IF NEW.config_generation < OLD.config_generation OR
    (OLD.config_generation > 0 AND NEW.config_generation = OLD.config_generation AND (
      NEW.config_digest IS DISTINCT FROM OLD.config_digest OR
      NEW.consumers_enabled IS DISTINCT FROM OLD.consumers_enabled OR
      NEW.minimum_writer_protocol IS DISTINCT FROM OLD.minimum_writer_protocol OR
      NEW.release_record IS DISTINCT FROM OLD.release_record)) THEN
    RAISE EXCEPTION 'Slack ingress deployment configuration cannot go backwards or conflict' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
`;

export const SLACK_INGRESS_TRUNCATE_FENCE_BODY = `
DECLARE required_protocol integer;
BEGIN
  SELECT minimum_writer_protocol INTO required_protocol
    FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE;
  IF NOT FOUND OR required_protocol > 0 THEN
    RAISE EXCEPTION 'Bulk Slack ingress removal is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
`;

export const SLACK_VERIFIED_INGRESS_FENCE_SQL = `
INSERT INTO slack_verified_ingress_rollout (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.slack_ingress_writer_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_row_fence$${SLACK_INGRESS_ROW_FENCE_BODY}$slack_row_fence$;
CREATE OR REPLACE FUNCTION public.slack_ingress_policy_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_policy_fence$${SLACK_INGRESS_POLICY_FENCE_BODY}$slack_policy_fence$;
CREATE OR REPLACE FUNCTION public.slack_ingress_truncate_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_truncate_fence$${SLACK_INGRESS_TRUNCATE_FENCE_BODY}$slack_truncate_fence$;
CREATE TRIGGER slack_ingress_normalized_writer_fence
  BEFORE INSERT OR UPDATE OR DELETE ON external_inbound_events
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_writer_fence_v1();
CREATE TRIGGER slack_ingress_raw_writer_fence
  BEFORE INSERT OR UPDATE OR DELETE ON slack_verified_ingress_events
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_writer_fence_v1();
CREATE TRIGGER slack_ingress_policy_floor_fence
  BEFORE UPDATE OR DELETE ON slack_verified_ingress_rollout
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_policy_fence_v1();
CREATE TRIGGER slack_ingress_policy_truncate_fence
  BEFORE TRUNCATE ON slack_verified_ingress_rollout
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_policy_fence_v1();
CREATE TRIGGER slack_ingress_normalized_truncate_fence
  BEFORE TRUNCATE ON external_inbound_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_truncate_fence_v1();
CREATE TRIGGER slack_ingress_raw_truncate_fence
  BEFORE TRUNCATE ON slack_verified_ingress_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_truncate_fence_v1();
`;
