-- Feature Flag Admin operator action "change a server's plan" (Tenny request,
-- 2026-11-17). Three times an operator needed `servers.plan` changed by hand
-- on the production database (e.g. `airwing` -> `founder`); that path (a direct
-- UPDATE on the main database) is gone. This follows the 0716 precedent: one
-- SECURITY DEFINER function, EXECUTE to `feature_flag_admin_operator`, and no
-- new table or column grants. The role still cannot UPDATE `servers` itself.
--
-- `public.ffa_change_server_plan(...)` is a single-row compare-and-set on
-- `servers.plan` under the server row lock (the same lock Stripe/AppSumo/
-- prepaid plan writers take). It uses the database clock (`now()`) only; no
-- caller-supplied time is trusted.
--   * writes the plan exactly as the billing projections do (billingService
--     Stripe sync, projectPaidSourceServerPlan): `plan`, `plan_downgraded_at`
--     (`now()` when the new plan is `free`, which starts the 7-day agent-stop
--     enforcement in downgradeEnforcement.ts; NULL otherwise) and
--     `updated_at`. No subscription, AppSumo, prepaid or billing row changes.
--     The `paid_lifecycle_servers_dirty` trigger (0510) fires, as for every
--     plan writer;
--   * the current plan must equal `p_expected_plan`, else `plan_mismatch`;
--   * refuses (`paid_source_active`) while a paid source would recompute the
--     plan: a Stripe subscription row that is not `canceled`, an active
--     AppSumo license, or a paid prepaid purchase not yet past its grace days;
--   * refuses `pro` as a target (`pro_owned_by_paid_sources`): `pro` is the
--     projection of a paid source. Without one, the next paid-source projection
--     for the server (projectPaidSourceServerPlan, the Stripe sync) writes it
--     back to `free`, and with a canceled subscription row plan resolution
--     already ignores a non-internal `servers.plan`. founder/partner are the
--     internal plans every paid-source writer preserves;
--   * when (and only when) it changes the plan, inserts one
--     `server.plan_changed` row into `integration_audit_events` in the same
--     transaction: the operator (actor), the approver's words and Raft message
--     id, the reason, the server, and from/to plan;
--   * returns a readback of the row it wrote.
-- Static schema-qualified SQL only, zero dynamic SQL.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ffa_change_server_plan(
  p_server_slug text,
  p_expected_plan text,
  p_plan text,
  p_reason text,
  p_actor_type text,
  p_actor_id text,
  p_actor_name text,
  p_approved_by text,
  p_approval_message_id text,
  p_request_id text,
  p_ffa_audit_event_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
-- `public` is on the path only for the 0510 trigger on servers.plan, whose
-- function calls paid_lifecycle_dirty_server() unqualified and inherits this
-- search_path. pg_catalog stays first, every reference below is
-- schema-qualified, and feature_flag_admin_operator has no CREATE on public.
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '5s'
AS $ffa_change_server_plan$
DECLARE
  v_server_id uuid;
  v_server_slug text;
  v_server_kind text;
  v_current_plan text;
  v_subscription_status text;
  v_has_active_appsumo boolean;
  v_has_prepaid boolean;
  v_blocking jsonb;
  v_after_plan text;
  v_after_downgraded_at timestamptz;
BEGIN
  IF p_server_slug IS NULL OR p_expected_plan IS NULL OR p_plan IS NULL
    OR p_reason IS NULL OR p_actor_type IS NULL OR p_actor_id IS NULL OR p_actor_name IS NULL
    OR p_approved_by IS NULL OR p_approval_message_id IS NULL
    OR p_request_id IS NULL OR p_ffa_audit_event_id IS NULL THEN
    RAISE EXCEPTION 'ffa_change_server_plan requires non-null arguments'
      USING ERRCODE = '22023';
  END IF;
  -- The values of servers.plan in packages/server/src/db/schema.ts.
  IF p_expected_plan NOT IN ('free', 'founder', 'partner', 'pro')
    OR p_plan NOT IN ('free', 'founder', 'partner', 'pro') THEN
    RAISE EXCEPTION 'ffa_change_server_plan plan must be free, founder, partner or pro'
      USING ERRCODE = '22023';
  END IF;
  -- Who operated and which human approval it acts on are mandatory.
  IF p_actor_type NOT IN ('human', 'agent')
    OR pg_catalog.length(pg_catalog.btrim(p_actor_id)) = 0
    OR pg_catalog.length(pg_catalog.btrim(p_reason)) < 3
    OR pg_catalog.length(pg_catalog.btrim(p_approved_by)) < 2
    OR pg_catalog.length(pg_catalog.btrim(p_approval_message_id)) < 4 THEN
    RAISE EXCEPTION 'ffa_change_server_plan requires an actor, a reason and the approval (words and message id)'
      USING ERRCODE = '22023';
  END IF;

  SELECT s.id, s.slug, s.kind, s.plan
  INTO v_server_id, v_server_slug, v_server_kind, v_current_plan
  FROM public.servers AS s
  WHERE s.slug = p_server_slug
    AND s.deleted_at IS NULL
  FOR UPDATE;

  IF v_server_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_server_kind <> 'normal' THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'not_found',
      'server_id', v_server_id,
      'server_slug', v_server_slug
    );
  END IF;
  IF v_current_plan <> p_expected_plan THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'plan_mismatch',
      'server_id', v_server_id,
      'server_slug', v_server_slug,
      'before_plan', v_current_plan,
      'plan', v_current_plan
    );
  END IF;

  SELECT sub.status
  INTO v_subscription_status
  FROM public.subscriptions AS sub
  WHERE sub.server_id = v_server_id;

  v_has_active_appsumo := EXISTS (
    SELECT 1
    FROM public.appsumo_license_bindings AS b
    INNER JOIN public.appsumo_licenses AS l
      ON l.product_id = b.product_id
      AND l.license_key = b.current_license_key
    WHERE b.server_id = v_server_id
      AND l.status = 'active'
      AND l.verified_at IS NOT NULL
      AND l.tier IN (1, 2, 3, 4)
  );
  -- Any paid purchase that is current, queued, or still in its grace days
  -- (PRO_PREPAID_GRACE_DAYS) will be projected onto servers.plan again.
  v_has_prepaid := EXISTS (
    SELECT 1
    FROM public.prepaid_pro_purchases AS p
    WHERE p.server_id = v_server_id
      AND p.status = 'paid'
      AND p.ends_at > (pg_catalog.now() - interval '3 days')
  );

  v_blocking := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'stripe_subscription', CASE
      WHEN v_subscription_status IS NOT NULL AND v_subscription_status <> 'canceled' THEN v_subscription_status
    END,
    'appsumo', CASE WHEN v_has_active_appsumo THEN true END,
    'prepaid', CASE WHEN v_has_prepaid THEN true END
  ));
  IF v_blocking <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'paid_source_active',
      'server_id', v_server_id,
      'server_slug', v_server_slug,
      'before_plan', v_current_plan,
      'plan', v_current_plan,
      'blocking', v_blocking
    );
  END IF;
  IF p_plan = 'pro' THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'pro_owned_by_paid_sources',
      'server_id', v_server_id,
      'server_slug', v_server_slug,
      'before_plan', v_current_plan,
      'plan', v_current_plan
    );
  END IF;

  IF p_plan = v_current_plan THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'unchanged',
      'server_id', v_server_id,
      'server_slug', v_server_slug,
      'before_plan', v_current_plan,
      'plan', v_current_plan
    );
  END IF;

  -- Same fields a billing downgrade/upgrade writes (billingService Stripe sync,
  -- projectPaidSourceServerPlan): plan_downgraded_at starts the 7-day
  -- agent-stop enforcement when the plan becomes free.
  UPDATE public.servers
  SET plan = p_plan,
    plan_downgraded_at = CASE WHEN p_plan = 'free' THEN pg_catalog.now() ELSE NULL END,
    updated_at = pg_catalog.now()
  WHERE id = v_server_id
    AND plan = p_expected_plan
    AND deleted_at IS NULL;

  -- Readback under the same row lock; anything but the requested plan undoes
  -- the statement.
  SELECT s.plan, s.plan_downgraded_at
  INTO v_after_plan, v_after_downgraded_at
  FROM public.servers AS s
  WHERE s.id = v_server_id;
  IF v_after_plan IS DISTINCT FROM p_plan THEN
    RAISE EXCEPTION 'ffa_change_server_plan readback mismatch'
      USING ERRCODE = '40001';
  END IF;

  -- Raft-side audit, same transaction: a changed plan always leaves this row.
  -- actor_id is a uuid column; a non-uuid principal id is kept in metadata.
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id,
    correlation_id, request_id, metadata, diff, created_at
  ) VALUES (
    pg_catalog.gen_random_uuid(),
    v_server_id,
    NULL,
    'server.plan_changed',
    'server_profile',
    'success',
    'web',
    p_actor_type,
    CASE
      WHEN p_actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_actor_id::uuid
    END,
    NULL,
    NULL,
    'server',
    v_server_id,
    p_ffa_audit_event_id,
    p_request_id,
    pg_catalog.jsonb_build_object(
      'serverSlug', v_server_slug,
      'fromPlan', v_current_plan,
      'toPlan', v_after_plan,
      'planDowngradedAt', v_after_downgraded_at,
      'reason', p_reason,
      'actorId', p_actor_id,
      'actorName', p_actor_name,
      'approvedBy', p_approved_by,
      'approvalMessageId', p_approval_message_id,
      'via', 'feature-flag-admin'
    ),
    pg_catalog.jsonb_build_object(
      'plan', pg_catalog.jsonb_build_object('before', v_current_plan, 'after', v_after_plan)
    ),
    pg_catalog.now()
  );

  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'updated',
    'server_id', v_server_id,
    'server_slug', v_server_slug,
    'before_plan', v_current_plan,
    'plan', v_after_plan,
    'plan_downgraded_at', v_after_downgraded_at
  );
END
$ffa_change_server_plan$;

REVOKE ALL PRIVILEGES ON FUNCTION public.ffa_change_server_plan(text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;


--> statement-breakpoint
-- The reconciler, redefined in full as every FFA privilege migration does;
-- the only change from 0716 is EXECUTE on ffa_change_server_plan and the
-- receipt's migration tag.
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
  -- Change one server's plan (0724): a compare-and-set on servers.plan only,
  -- refused while a Stripe subscription, AppSumo license or prepaid purchase
  -- is live. The role holds no UPDATE on servers.
  EXECUTE 'REVOKE ALL PRIVILEGES ON FUNCTION public.ffa_change_server_plan(text, text, text, text, text, text, text, text, text, text, text) FROM feature_flag_admin_operator';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.ffa_change_server_plan(text, text, text, text, text, text, text, text, text, text, text) TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0724_ffa_server_plan_change',
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
