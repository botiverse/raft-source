-- Feature Flag Admin may resolve stuck interactive link card operations
-- (RFC 076 §5.2, Tenny 6f7ff6db). An operation that stays unknown for 24 hours
-- becomes needs_reconciliation; a human platform admin can mark it
-- resolved_manually with a reason. The reconciler is redefined in full (as
-- every FFA privilege migration does) and adds a column-level read of
-- link_card_operations and UPDATE on only the resolution columns. A trigger
-- then enforces the operation state machine for every writer, so the FFA grant
-- on `state` cannot move an operation anywhere but needs_reconciliation ->
-- resolved_manually that the service would not also allow, and no terminal
-- state ever moves back. Production deploy reconciles and verifies the receipt
-- right after migrations.
CREATE OR REPLACE FUNCTION public.reconcile_feature_flag_admin_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $feature_flag_admin_privileges$
DECLARE
  projection record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'feature_flag_admin_operator'
  ) THEN
    RAISE EXCEPTION 'feature_flag_admin_operator is required before privilege reconciliation'
      USING ERRCODE = '42704';
  END IF;

  EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA public FROM feature_flag_admin_operator';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.announcement_audit_events, public.announcement_image_assets, public.feature_flags, public.feature_flag_rules, public.feature_flag_audiences, public.feature_flag_audience_members, public.users, public.servers, public.server_members, public.subscriptions, public.server_lab_enrollments, public.server_lab_access, public.lab_definitions, public.agents, public.official_app_registry, public.oauth_clients, public.integration_audit_events, public.link_card_operations FROM feature_flag_admin_operator';
  FOR projection IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (
      'announcements',
      'announcement_audit_events',
      'announcement_image_assets',
      'feature_flags',
      'feature_flag_rules',
      'feature_flag_audiences',
      'feature_flag_audience_members',
      'users',
      'servers',
      'server_members',
      'subscriptions',
      'server_lab_enrollments',
      'server_lab_access',
      'lab_definitions',
      'agents',
      'official_app_registry',
      'oauth_clients',
      'integration_audit_events',
      'link_card_operations'
    )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM feature_flag_admin_operator',
      projection.column_name,
      projection.table_schema,
      projection.table_name
    );
  END LOOP;

  EXECUTE 'GRANT USAGE ON SCHEMA public TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.announcements TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE public.announcement_audit_events TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcement_image_assets TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feature_flags, public.feature_flag_rules TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.feature_flag_audiences TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE public.feature_flag_audience_members TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id) ON TABLE public.users TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id, slug, deleted_at, plan, kind) ON TABLE public.servers TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, user_id, role) ON TABLE public.server_members TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, plan, status) ON TABLE public.subscriptions TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, lab_key, enabled) ON TABLE public.server_lab_enrollments TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (server_id, enabled) ON TABLE public.server_lab_access TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (key, name, description, state, created_at, updated_at) ON TABLE public.lab_definitions TO feature_flag_admin_operator';
  EXECUTE 'GRANT INSERT (key, name, description, state, created_at, updated_at) ON TABLE public.lab_definitions TO feature_flag_admin_operator';
  EXECUTE 'GRANT UPDATE (name, description, state, updated_at) ON TABLE public.lab_definitions TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id, server_id, deleted_at) ON TABLE public.agents TO feature_flag_admin_operator';
  -- Official app registry (#proj-apps task #5): operators list, register,
  -- approve and disable entries. No DELETE: a retired entry is
  -- status = 'disabled'. Updates touch only the reviewable fields and bump
  -- revision, which official auto-install re-reads at its write point.
  EXECUTE 'GRANT SELECT (oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) ON TABLE public.official_app_registry TO feature_flag_admin_operator';
  EXECUTE 'GRANT INSERT (oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) ON TABLE public.official_app_registry TO feature_flag_admin_operator';
  EXECUTE 'GRANT UPDATE (auto_install, purpose, status, revision, updated_by_user_id, updated_at) ON TABLE public.official_app_registry TO feature_flag_admin_operator';
  -- Which app an entry names, and that its identity matches oauth_clients.
  EXECUTE 'GRANT SELECT (id, client_id, server_id, name, app_type, publish_status, enabled) ON TABLE public.oauth_clients TO feature_flag_admin_operator';
  -- Every registry write leaves a Raft-side integration audit event in the same
  -- transaction. Append-only: no SELECT, UPDATE or DELETE.
  EXECUTE 'GRANT INSERT (id, server_id, client_id, event_type, event_category, outcome, source, actor_type, actor_id, subject_type, subject_id, target_type, target_id, request_id, metadata, diff, created_at) ON TABLE public.integration_audit_events TO feature_flag_admin_operator';
  -- Stuck interactive link card operations (RFC 076 §5.2): list them and mark
  -- one resolved_manually. No INSERT or DELETE; view_nonce, request_sha256
  -- and registration_revision stay unreadable. receipt_revision is bumped by
  -- the trigger below, never written by this role.
  EXECUTE 'GRANT SELECT (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key, message_id, action_id, state, receipt_revision, last_status_at, resolved_by_user_id, resolution_reason, resolved_at, created_at, updated_at) ON TABLE public.link_card_operations TO feature_flag_admin_operator';
  EXECUTE 'GRANT UPDATE (state, resolved_by_user_id, resolution_reason, resolved_at, updated_at) ON TABLE public.link_card_operations TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0387_ffa_link_card_resolution_privileges',
    clock_timestamp(),
    current_user
  )
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
END
$feature_flag_admin_privileges$;

REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_feature_flag_admin_privileges() FROM PUBLIC;

--> statement-breakpoint
-- The operation state machine (RFC 076 §3.4, §5.2), enforced for every writer:
-- nothing moves back and terminal states never move. Feature Flag Admin may do
-- exactly one thing (Tenny d4dcfdbd): close a needs_reconciliation operation as
-- resolved_manually, which leaves the outcome undetermined. It can never record
-- an App outcome (done/refused/failed_not_sent), and only it can resolve
-- manually. Its resolution bumps receipt_revision by exactly 1.
CREATE OR REPLACE FUNCTION public.link_card_operations_guard_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $link_card_transition$
BEGIN
  IF current_user = 'feature_flag_admin_operator' THEN
    IF NOT (OLD.state = 'needs_reconciliation' AND NEW.state = 'resolved_manually') THEN
      RAISE EXCEPTION 'link_card_operations: Feature Flag Admin may only resolve a needs_reconciliation operation (% -> %)', OLD.state, NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'link_card_operations_state_transition';
    END IF;
    NEW.receipt_revision := OLD.receipt_revision + 1;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'requested' AND NEW.state IN ('sent', 'failed_not_sent'))
    OR (OLD.state = 'sent' AND NEW.state IN ('accepted', 'done', 'refused', 'failed_not_sent', 'unknown'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('done', 'refused', 'failed_not_sent', 'unknown', 'needs_reconciliation'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('accepted', 'done', 'refused', 'failed_not_sent', 'needs_reconciliation'))
    OR (OLD.state = 'needs_reconciliation' AND NEW.state IN ('done', 'refused', 'failed_not_sent'))
  ) THEN
    RAISE EXCEPTION 'link_card_operations: % -> % is not an allowed transition', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'link_card_operations_state_transition';
  END IF;
  RETURN NEW;
END
$link_card_transition$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS link_card_operations_state_transition ON public.link_card_operations;
--> statement-breakpoint
-- Every UPDATE, not only UPDATE OF state: the FFA role may not touch a row
-- outside its one transition (for example, rewrite an earlier reason).
CREATE TRIGGER link_card_operations_state_transition
  BEFORE UPDATE ON public.link_card_operations
  FOR EACH ROW EXECUTE FUNCTION public.link_card_operations_guard_transition();
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.link_card_operations_guard_transition() FROM PUBLIC;
