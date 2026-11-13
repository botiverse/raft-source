-- Permission update review as a database function (#proj-apps task #19, step
-- S2), next to the card URL review of marketplace_review_decider_gate:
--
--   marketplace_approve_permission_review  the decision body (owner-only)
--   app_admin_approve_permission_review    the gate, then the body (App Admin)
--
-- Approving an App's pending App Notifications permission revision (RFC 051)
-- is what the server's approvePendingAppOutboundPermissionRevision did in
-- TypeScript until now, moved as it was. For one App, nothing else:
--
--   - the App row is locked (only a user-managed App: not slock_builtin, no
--     external_app_registrations row), then its pending revision becomes
--     active with the reviewer and the review time;
--   - the App's current revision, groups and events become the revision's,
--     and its pending pointer is cleared;
--   - the source Server's active installation (no other Server's) takes the
--     revision's groups and events; its grant revision moves when its groups
--     differ, its subscription revision when its events differ, compared as
--     the server compared them: the installation's list sorted (byte order
--     under COLLATE "C", JavaScript's sort() for these ASCII names) against
--     the revision's list as stored, element by element, so a duplicate
--     counts as a difference;
--   - where the groups differed, that installation's unrevoked installation
--     tokens are revoked;
--   - one app.outbound_permission_approved audit event (actor the human
--     reviewer, category scope, metadata clientKey, revision, groupCount,
--     eventCount), as integrationAuditService writes it.
--
-- No socket event, outbox row or cache follows the server's approval, so a
-- call from App Admin's entry is the whole decision too.
--
-- Who may review stays with the caller (the server's reviewer list, or the
-- gated entry below). Invoker rights and executable by its owner only, like
-- the gate: the server calls it as the owner, and the entry runs it as the
-- owner. search_path pg_catalog, then pg_temp; every relation
-- schema-qualified; no dynamic SQL.
--
-- A NULL expected revision approves whatever is pending: the server's route
-- keeps the field optional for legacy callers. The entry refuses NULL.
--
-- Errors:
--   RVW01 invalid argument: no App or reviewer id; unknown or retired
--         reviewer
--   RVW02 no such App
--   RVW03 a platform-managed App (slock_builtin, or one with an
--         external_app_registrations row)
--   RVW04 no permission revision is waiting for review, or the one the App
--         points at is no longer pending_review (or is another App's)
--   RVW05 the pending revision is not the one the reviewer was shown; DETAIL
--         is JSON {"pendingRevisionId": <the pending revision now>}
--
-- The result is jsonb: revisionId, revision, state, requestedGroups,
-- requestedEvents (the approved revision), syncedInstallCount (source
-- installations rewritten, 0 or 1) and revokedTokenCount.
CREATE FUNCTION public.marketplace_approve_permission_review(
  p_client_id uuid,
  p_expected_revision_id uuid,
  p_reviewer_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $marketplace_approve_permission_review$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_client record;
  v_revision record;
  v_install record;
  v_groups_changed boolean;
  v_events_changed boolean;
  v_changed_install_ids uuid[] := '{}';
  v_rows integer;
  v_synced integer := 0;
  v_revoked integer := 0;
BEGIN
  -- ── Arguments ──────────────────────────────────────────────────────────
  IF p_client_id IS NULL OR p_reviewer_user_id IS NULL THEN
    RAISE EXCEPTION 'p_client_id and p_reviewer_user_id are required' USING ERRCODE = 'RVW01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_reviewer_user_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'unknown reviewer' USING ERRCODE = 'RVW01';
  END IF;

  -- ── The App, locked, with what the reviewer was shown ──────────────────
  -- The server's lock: the App row, only when it is user-managed
  -- (oauthClientIsUserManagedPredicate).
  SELECT c.id, c.server_id, c.client_id AS client_key, c.outbound_pending_revision_id AS pending_revision_id
    INTO v_client
    FROM public.oauth_clients c
    WHERE c.id = p_client_id
      AND c.app_type <> 'slock_builtin'
      AND NOT EXISTS (
        SELECT 1 FROM public.external_app_registrations platform_registration
        WHERE platform_registration.oauth_client_id = c.id
      )
    LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.oauth_clients WHERE id = p_client_id) THEN
      RAISE EXCEPTION 'App not found' USING ERRCODE = 'RVW02';
    END IF;
    RAISE EXCEPTION 'a platform-managed App has no permission review' USING ERRCODE = 'RVW03';
  END IF;
  IF v_client.pending_revision_id IS NULL THEN
    RAISE EXCEPTION 'no permission revision is waiting for review' USING ERRCODE = 'RVW04';
  END IF;
  IF p_expected_revision_id IS NOT NULL AND p_expected_revision_id <> v_client.pending_revision_id THEN
    RAISE EXCEPTION 'the pending permission revision changed since it was shown'
      USING ERRCODE = 'RVW05',
            DETAIL = pg_catalog.jsonb_build_object('pendingRevisionId', v_client.pending_revision_id)::text;
  END IF;

  -- ── The revision ───────────────────────────────────────────────────────
  UPDATE public.oauth_app_permission_revisions r SET
    state = 'active',
    reviewed_by_user_id = p_reviewer_user_id,
    reviewed_at = v_now
  WHERE r.id = v_client.pending_revision_id
    AND r.client_id = v_client.id
    AND r.state = 'pending_review'
  RETURNING r.id, r.revision, r.state, r.requested_groups, r.requested_events
  INTO v_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the pending permission revision is no longer waiting for review' USING ERRCODE = 'RVW04';
  END IF;

  UPDATE public.oauth_clients SET
    outbound_current_revision_id = v_revision.id,
    outbound_pending_revision_id = NULL,
    outbound_current_groups = v_revision.requested_groups,
    outbound_current_events = v_revision.requested_events,
    updated_at = v_now
  WHERE id = v_client.id;

  -- ── The source Server's active installation ────────────────────────────
  -- Read without a lock, then each row written from what was read, as the
  -- server did. Changed: the installation's list, sorted, is not the
  -- revision's list element for element.
  FOR v_install IN
    SELECT i.id, i.approved_groups, i.grant_revision, i.subscribed_events, i.subscription_revision
      FROM public.oauth_client_installs i
      WHERE i.client_id = v_client.id
        AND i.server_id = v_client.server_id
        AND i.status = 'active'
  LOOP
    v_groups_changed := coalesce(
      (SELECT pg_catalog.jsonb_agg(g.value ORDER BY (g.value #>> '{}') COLLATE "C")
         FROM pg_catalog.jsonb_array_elements(v_install.approved_groups) AS g),
      '[]'::jsonb
    ) IS DISTINCT FROM v_revision.requested_groups;
    v_events_changed := coalesce(
      (SELECT pg_catalog.jsonb_agg(e.value ORDER BY (e.value #>> '{}') COLLATE "C")
         FROM pg_catalog.jsonb_array_elements(v_install.subscribed_events) AS e),
      '[]'::jsonb
    ) IS DISTINCT FROM v_revision.requested_events;
    UPDATE public.oauth_client_installs SET
      approved_request_revision_id = v_revision.id,
      approved_groups = v_revision.requested_groups,
      grant_revision = CASE WHEN v_groups_changed THEN v_install.grant_revision + 1 ELSE v_install.grant_revision END,
      subscribed_events = v_revision.requested_events,
      subscription_revision = CASE WHEN v_events_changed THEN v_install.subscription_revision + 1 ELSE v_install.subscription_revision END,
      updated_at = v_now
    WHERE id = v_install.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_synced := v_synced + v_rows;
    IF v_groups_changed THEN
      v_changed_install_ids := v_changed_install_ids || v_install.id;
    END IF;
  END LOOP;

  -- Installation tokens minted for groups that changed stop working.
  IF pg_catalog.cardinality(v_changed_install_ids) > 0 THEN
    UPDATE public.oauth_app_installation_tokens SET
      revoked_at = v_now
    WHERE installation_id = ANY (v_changed_install_ids)
      AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
  END IF;

  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_client.server_id, v_client.id, 'app.outbound_permission_approved', 'scope', 'success', 'api',
    'human', p_reviewer_user_id, 'app', v_client.id, 'app', v_client.id,
    pg_catalog.jsonb_build_object(
      'clientKey', v_client.client_key,
      'revision', v_revision.revision,
      'groupCount', pg_catalog.jsonb_array_length(v_revision.requested_groups),
      'eventCount', pg_catalog.jsonb_array_length(v_revision.requested_events)
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'revisionId', v_revision.id,
    'revision', v_revision.revision,
    'state', v_revision.state,
    'requestedGroups', v_revision.requested_groups,
    'requestedEvents', v_revision.requested_events,
    'syncedInstallCount', v_synced,
    'revokedTokenCount', v_revoked
  );
END
$marketplace_approve_permission_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_approve_permission_review(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- The entry App Admin calls: the gate (the decider's Botiverse membership row
-- locked until the transaction ends), then the body, so the membership row is
-- always locked before the App's. SECURITY DEFINER, so a caller needs EXECUTE
-- only; the gate and the body run as the owner. App Admin always says which
-- revision it showed: a NULL expected revision is RVW01 here (after the gate,
-- so a refused actor still learns nothing but RVW07); the body's results and
-- refusals pass through unchanged.
CREATE FUNCTION public.app_admin_approve_permission_review(
  p_client_id uuid,
  p_expected_revision_id uuid,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_approve_permission_review$
BEGIN
  PERFORM public.marketplace_review_require_decider(p_actor_type, p_actor_id);
  IF p_expected_revision_id IS NULL THEN
    RAISE EXCEPTION 'expected revision must be the pending revision shown' USING ERRCODE = 'RVW01';
  END IF;
  RETURN public.marketplace_approve_permission_review(p_client_id, p_expected_revision_id, p_actor_id);
END
$app_admin_approve_permission_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_approve_permission_review(uuid, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Redefined in full, as each App Admin contract migration does: App Admin's
-- role may use schema public and execute the three review entries and the two
-- registry functions, nothing else. The bodies (the permission body now too)
-- and the gate are revoked by name, so a stray grant cannot survive a deploy.
-- Until the role exists this returns false and writes nothing; the server
-- deploy runs it after migrations (scripts/verify-app-admin-privileges.ts)
-- and reads back the receipt and the role's effective privileges.
CREATE OR REPLACE FUNCTION public.reconcile_app_admin_privileges()
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $reconcile_app_admin_privileges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_admin_operator') THEN
    RETURN false;
  END IF;

  REVOKE ALL PRIVILEGES ON SCHEMA public FROM app_admin_operator;
  GRANT USAGE ON SCHEMA public TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_decide_publish_review(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_decide_action_endpoint_review(uuid, text, text, uuid, text) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_approve_permission_review(uuid, uuid, uuid) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_review_require_decider(text, uuid) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_approve_permission_review(uuid, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_approve_permission_review(uuid, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.official_app_registry_register(uuid, text, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.official_app_registry_register(uuid, text, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.official_app_registry_update(uuid, integer, text, text, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.official_app_registry_update(uuid, integer, text, text, text, uuid) TO app_admin_operator;

  INSERT INTO public.app_admin_privilege_receipts (contract_key, migration_tag, applied_at, applied_by)
  VALUES ('app-admin-functions-v4', '0564_marketplace_permission_review_fn', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
