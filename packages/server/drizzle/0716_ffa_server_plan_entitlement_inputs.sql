-- Single-server billing entitlement inputs for Feature Flag Admin's `plan`-rule
-- preview (#raft-feature-flag:#7; Tenny 9048d377 / 5a19f4ae, following the
-- 0617_announcement_rules_reach precedent: a read-only SECURITY DEFINER
-- function, EXECUTE to the FFA role, no new table or column grants).
--
-- `feature_flag_admin_operator` holds no privileges on `appsumo_licenses`,
-- `appsumo_license_bindings`, or `prepaid_pro_purchases`, and must never read
-- `license_key`, tier, payment/checkout/customer IDs, or payment amounts. This
-- function takes one `p_server_id` and `p_now`, executes static schema-qualified
-- SQL only (zero dynamic SQL, `search_path = pg_catalog, pg_temp`), and returns
-- either NULL (missing or soft-deleted server) or a fixed JSONB projection of
-- non-secret plan-resolution inputs:
--   {
--     "server_plan": text,
--     "subscription_plan": text | null,
--     "subscription_status": text | null,
--     "has_active_appsumo": boolean,
--     "prepaid_purchases": [{ "kind", "seat_quantity", "starts_at", "ends_at" }]
--   }
-- Both `planService.ts` and the FFA Worker resolve the effective server plan
-- from these exact inputs through `@botiverse/raft-shared`.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ffa_server_plan_entitlement_inputs(
  p_server_id uuid,
  p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $ffa_server_plan_entitlement_inputs$
DECLARE
  v_result jsonb;
BEGIN
  IF p_server_id IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'ffa_server_plan_entitlement_inputs requires non-null p_server_id and p_now'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.jsonb_build_object(
      'server_plan', s.plan,
      'subscription_plan', sub.plan,
      'subscription_status', sub.status,
      'has_active_appsumo', EXISTS (
        SELECT 1
        FROM public.appsumo_license_bindings AS b
        INNER JOIN public.appsumo_licenses AS l
          ON l.product_id = b.product_id
          AND l.license_key = b.current_license_key
        WHERE b.server_id = s.id
          AND s.kind = 'normal'
          AND l.status = 'active'
          AND l.verified_at IS NOT NULL
          AND l.tier IN (1, 2, 3, 4)
      ),
      'prepaid_purchases', COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'kind', p.kind,
              'seat_quantity', p.seat_quantity,
              'starts_at', p.starts_at,
              'ends_at', p.ends_at
            )
            ORDER BY p.starts_at ASC, p.id ASC
          )
          FROM public.prepaid_pro_purchases AS p
          WHERE p.server_id = s.id
            AND s.kind = 'normal'
            AND p.status = 'paid'
            AND p.ends_at > (p_now - interval '3 days')
        ),
        '[]'::jsonb
      )
    )
  INTO v_result
  FROM public.servers AS s
  LEFT JOIN public.subscriptions AS sub
    ON sub.server_id = s.id
  WHERE s.id = p_server_id
    AND s.deleted_at IS NULL;

  RETURN v_result;
END
$ffa_server_plan_entitlement_inputs$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ffa_server_plan_entitlement_inputs(uuid, timestamptz) FROM PUBLIC;

--> statement-breakpoint
-- The reconciler, redefined in full as every FFA privilege migration does;
-- the only change from 0617 is EXECUTE on ffa_server_plan_entitlement_inputs
-- and the receipt's migration tag.
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
  -- Announcement reach with audience rules (0617): a count, never rows. The
  -- function reads users.created_at / display_language and servers.created_at
  -- itself; this role still cannot select those columns.
  EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.announcement_rules_reach(jsonb, text, uuid[], uuid[], timestamptz) FROM feature_flag_admin_operator';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.announcement_rules_reach(jsonb, text, uuid[], uuid[], timestamptz) TO feature_flag_admin_operator';
  -- Single-server plan entitlement inputs for feature-flag preview (0716):
  -- non-secret fields only (`server_plan`, `subscription_plan`,
  -- `subscription_status`, `has_active_appsumo`, and paid `prepaid_purchases`
  -- `{ kind, seat_quantity, starts_at, ends_at }`). `appsumo_licenses`,
  -- `appsumo_license_bindings`, and `prepaid_pro_purchases` remain unreadable.
  EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.ffa_server_plan_entitlement_inputs(uuid, timestamptz) FROM feature_flag_admin_operator';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.ffa_server_plan_entitlement_inputs(uuid, timestamptz) TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0716_ffa_server_plan_entitlement_inputs',
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
