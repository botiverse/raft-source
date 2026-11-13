-- Marketplace publish/offline review decision as one database function
-- (#proj-apps task #19, df270fd4). The Raft server and App Admin both call it,
-- so the decision has one implementation; App Admin's role gets EXECUTE on it
-- and nothing else (Tenny 3b715a22), the Feature Flag Admin way: a reconciler
-- owned by migrations plus a receipt the deploy reads back.
-- schema-snapshot: unchanged (two functions and app_admin_privilege_receipts, which schema.ts does not declare, like feature_flag_admin_privilege_receipts)
CREATE TABLE IF NOT EXISTS public.app_admin_privilege_receipts (
  contract_key text PRIMARY KEY,
  migration_tag text NOT NULL,
  applied_at timestamptz NOT NULL,
  applied_by text NOT NULL
);
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.app_admin_privilege_receipts FROM PUBLIC;
--> statement-breakpoint
-- What the server's reviewOAuthClientPublish did in TypeScript until now, for
-- one App (p_client_id) and the rows hanging off it, nothing else:
--
--   status               approve                      reject
--   publish_requested,   published (listed, the        rejected (+ reason)
--   in_review            action endpoint back to
--                        review, source install)
--   unpublish_requested  private (other Servers'       published (+ reason)
--                        installs, bots and access
--                        removed; source kept)
--
-- SECURITY DEFINER: runs with the owner's rights, so a caller needs EXECUTE
-- only, and the triggers on these tables (App root sync, change_log) run as
-- the owner too. Every relation is schema-qualified, so none can resolve to a
-- caller's temporary table of the same name; search_path is pg_catalog, then
-- pg_temp last (left out, pg_temp would be searched first), and functions and
-- operators never resolve through pg_temp. No dynamic SQL.
--
-- Who may review (the server's SLOCK_MARKETPLACE_REVIEWER_USER_IDS, App
-- Admin's own gate) stays with the caller. Errors use SQLSTATE class RV:
--   RVW01 invalid argument (incl. unknown or retired actor)
--   RVW02 no such App
--   RVW03 platform-managed App (slock_builtin or external registration)
--   RVW04 the App has no publish/offline request open
--   RVW05 the request is not in p_expected_status any more (compare-and-swap)
--   RVW06 publishing needs a description
CREATE FUNCTION public.marketplace_decide_publish_review(
  p_client_id uuid,
  p_decision text,
  p_expected_status text,
  p_actor_type text,
  p_actor_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $marketplace_decide_publish_review$
DECLARE
  -- RAFT_OAUTH_DEFAULT_ALLOWED_SCOPES (packages/shared/src/oauthScopes.ts):
  -- what an App that declares no scopes may request.
  c_default_scopes CONSTANT jsonb := '["openid", "profile", "identity"]';
  -- JavaScript's String.prototype.trim() whitespace, so a description or
  -- reason counts as blank exactly when the server's trim() said so.
  c_space CONSTANT text := E'\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
  v_now timestamptz := pg_catalog.now();
  v_approve boolean;
  v_offline boolean;
  v_reason text;
  v_reviewer_user_id uuid;
  v_client record;
  v_next_status text;
  v_next_app_type text;
  v_effective_scopes jsonb;
  v_text_revision_id uuid;
  v_text record;
  v_link record;
  v_source record;
  v_bot record;
  v_removed_install_ids uuid[] := '{}';
  v_removed_server_ids uuid[] := '{}';
  v_removed_bots jsonb := '[]';
  v_removed_install_count integer := 0;
  v_installed_count integer := 0;
  v_denied_request_count integer := 0;
  v_revoked_grant_count integer := 0;
  v_revoked_token_count integer := 0;
  v_endpoint_to_review boolean := false;
  v_metadata jsonb;
BEGIN
  -- ── Arguments ──────────────────────────────────────────────────────────
  IF p_client_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'p_client_id and p_actor_id are required' USING ERRCODE = 'RVW01';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'RVW01';
  END IF;
  IF p_expected_status IS NULL OR p_expected_status NOT IN ('publish_requested', 'in_review', 'unpublish_requested') THEN
    RAISE EXCEPTION 'expected status must be publish_requested, in_review or unpublish_requested' USING ERRCODE = 'RVW01';
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') THEN
    RAISE EXCEPTION 'actor type must be human or agent' USING ERRCODE = 'RVW01';
  END IF;
  v_approve := p_decision = 'approve';
  IF v_approve AND p_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a reason is recorded only with reject' USING ERRCODE = 'RVW01';
  END IF;
  v_reason := NULLIF(pg_catalog.regexp_replace(p_reason, '^[' || c_space || ']+|[' || c_space || ']+$', '', 'g'), '');
  IF pg_catalog.char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'reason must be at most 1000 characters' USING ERRCODE = 'RVW01';
  END IF;

  -- Reviewer columns reference users; an agent reviewer leaves them null and
  -- is named in the audit events.
  IF p_actor_type = 'human' THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor_id AND retired_at IS NULL) THEN
      RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'RVW01';
    END IF;
    v_reviewer_user_id := p_actor_id;
  ELSIF NOT EXISTS (SELECT 1 FROM public.agents WHERE id = p_actor_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'RVW01';
  END IF;

  -- ── The App, locked, in the state the reviewer was shown ─────────────────
  SELECT c.id, c.server_id, c.client_id, c.app_type, c.publish_status, c.description,
         c.allowed_scopes, c.created_by_user_id, c.outbound_current_revision_id, c.outbound_current_groups
    INTO v_client
    FROM public.oauth_clients c
    WHERE c.id = p_client_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'App not found' USING ERRCODE = 'RVW02';
  END IF;
  IF v_client.app_type = 'slock_builtin'
    OR EXISTS (SELECT 1 FROM public.external_app_registrations WHERE oauth_client_id = p_client_id) THEN
    RAISE EXCEPTION 'the App is platform-managed' USING ERRCODE = 'RVW03';
  END IF;
  IF v_client.publish_status NOT IN ('publish_requested', 'in_review', 'unpublish_requested') THEN
    RAISE EXCEPTION 'the App has no open publish or offline request'
      USING ERRCODE = 'RVW04', DETAIL = 'status: ' || v_client.publish_status;
  END IF;
  IF v_client.publish_status <> p_expected_status THEN
    RAISE EXCEPTION 'the request changed since it was shown'
      USING ERRCODE = 'RVW05', DETAIL = 'status: ' || v_client.publish_status;
  END IF;

  v_offline := v_client.publish_status = 'unpublish_requested';
  v_next_status := CASE
    WHEN v_offline AND v_approve THEN 'private'
    WHEN v_offline THEN 'published'
    WHEN v_approve THEN 'published'
    ELSE 'rejected'
  END;
  v_next_app_type := CASE WHEN v_offline OR v_approve THEN 'third_party_global' ELSE v_client.app_type END;

  IF v_approve AND NOT v_offline
    AND NOT coalesce(v_client.description ~ ('[^' || c_space || ']'), false) THEN
    RAISE EXCEPTION 'description is required before publishing to marketplace' USING ERRCODE = 'RVW06';
  END IF;

  -- Offline approval removes the App from every Server but its own: lock
  -- those installations before anything changes.
  IF v_offline AND v_approve THEN
    SELECT coalesce(pg_catalog.array_agg(locked.id), '{}'), coalesce(pg_catalog.array_agg(locked.server_id), '{}')
      INTO v_removed_install_ids, v_removed_server_ids
      FROM (
        SELECT i.id, i.server_id
          FROM public.oauth_client_installs i
          WHERE i.client_id = p_client_id AND i.server_id <> v_client.server_id
          ORDER BY i.id
          FOR UPDATE
      ) locked;
  END IF;

  UPDATE public.oauth_clients SET
    app_type = v_next_app_type,
    enabled = true,
    publish_status = v_next_status,
    human_marketplace_visible = CASE WHEN v_approve THEN NOT v_offline ELSE human_marketplace_visible END,
    publish_rejection_reason = CASE WHEN v_approve THEN NULL ELSE v_reason END,
    publish_reviewed_at = v_now,
    publish_reviewed_by_user_id = v_reviewer_user_id,
    updated_at = v_now
  WHERE id = p_client_id;

  -- What an approval installs on the App's own Server: the login scopes it
  -- may request (effectiveAllowedOAuthScopes) and its current prompt text as
  -- confirmed. An App created before text revisions existed gets revision 1
  -- from its live text first (ensureCurrentTextRevision).
  IF v_approve THEN
    IF v_client.allowed_scopes IS NULL OR pg_catalog.json_typeof(v_client.allowed_scopes) = 'null'
      OR (pg_catalog.json_typeof(v_client.allowed_scopes) = 'array' AND pg_catalog.json_array_length(v_client.allowed_scopes) = 0) THEN
      v_effective_scopes := c_default_scopes;
    ELSIF pg_catalog.json_typeof(v_client.allowed_scopes) = 'array' THEN
      v_effective_scopes := v_client.allowed_scopes::jsonb;
    ELSE
      RAISE EXCEPTION 'allowed_scopes of App % is not an array', p_client_id;
    END IF;

    SELECT c.text_current_revision_id, c.text_revision, c.name, c.description, c.when_to_use
      INTO v_text
      FROM public.oauth_clients c
      WHERE c.id = p_client_id;
    v_text_revision_id := v_text.text_current_revision_id;
    IF v_text_revision_id IS NULL THEN
      v_text_revision_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.oauth_app_text_revisions (id, client_id, revision, name, description, when_to_use, state, created_by_type)
        VALUES (v_text_revision_id, p_client_id, v_text.text_revision + 1, v_text.name, v_text.description, v_text.when_to_use, 'active', 'system');
      UPDATE public.oauth_clients SET
        text_revision = v_text.text_revision + 1,
        text_current_revision_id = v_text_revision_id,
        local_confirmed_text_revision_id = coalesce(local_confirmed_text_revision_id, v_text_revision_id)
      WHERE id = p_client_id;
    END IF;
  END IF;

  IF v_offline AND v_approve THEN
    -- The publisher keeps its own installation, consent and bot as they are.
    -- Only if it was missing does it come back, with basic login only.
    INSERT INTO public.oauth_client_installs (
      id, server_id, client_id, installed_by_system, approved_scopes,
      confirmed_text_revision_id, text_confirmed_by_user_id, text_confirmed_at
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_client.server_id, p_client_id, true, v_effective_scopes,
      v_text_revision_id, NULL, v_now
    ) ON CONFLICT DO NOTHING;

    -- Each removed installation's bot (appBotIdentityService.uninstallManagedAppBot):
    -- binding uninstalled, agent soft-deleted (kept for attribution), every
    -- credential of the installation's bot agents revoked. Before the
    -- installation rows go, which would cascade the bindings away.
    FOR v_bot IN
      UPDATE public.app_bot_bindings b SET state = 'uninstalled', uninstalled_at = v_now, updated_at = v_now
        WHERE b.install_id = ANY (v_removed_install_ids) AND b.state <> 'uninstalled'
        RETURNING b.install_id, b.agent_id, b.server_id
    LOOP
      UPDATE public.agents SET deleted_at = v_now, updated_at = v_now WHERE id = v_bot.agent_id;
      UPDATE public.agent_credentials SET revoked_at = v_now, revoked_reason = 'bot_uninstalled'
        WHERE revoked_at IS NULL
          AND agent_id IN (SELECT agent_id FROM public.app_bot_bindings WHERE install_id = v_bot.install_id);
      v_removed_bots := v_removed_bots || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('agentId', v_bot.agent_id, 'serverId', v_bot.server_id));
    END LOOP;

    DELETE FROM public.oauth_client_installs WHERE id = ANY (v_removed_install_ids);
    GET DIAGNOSTICS v_removed_install_count = ROW_COUNT;

    -- Requests first, open ones included: an approved Login with Raft whose
    -- code is not exchanged yet would otherwise still mint a token. The
    -- exchange locks its request row, so it either commits before this (and
    -- the revocations below catch it) or finds the request denied.
    UPDATE public.oauth_access_requests SET
      status = 'denied', remember = false, resolved_by_user_id = v_reviewer_user_id,
      resolved_at = v_now, updated_at = v_now
    WHERE client_id = p_client_id AND server_id = ANY (v_removed_server_ids)
      AND (status = 'pending' OR (status = 'approved' AND consumed_at IS NULL));
    GET DIAGNOSTICS v_denied_request_count = ROW_COUNT;
    UPDATE public.oauth_grants SET revoked_by_user_id = v_reviewer_user_id, revoked_at = v_now, updated_at = v_now
      WHERE client_id = p_client_id AND server_id = ANY (v_removed_server_ids) AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked_grant_count = ROW_COUNT;
    UPDATE public.oauth_access_tokens SET revoked_at = v_now
      WHERE client_id = p_client_id AND server_id = ANY (v_removed_server_ids) AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked_token_count = ROW_COUNT;
    UPDATE public.oauth_user_consents SET revoked_at = v_now, updated_at = v_now
      WHERE client_id = p_client_id AND server_id = ANY (v_removed_server_ids) AND revoked_at IS NULL;
    -- A link-preview decline belongs to the installation it answered.
    DELETE FROM public.oauth_link_preview_declines
      WHERE client_id = p_client_id AND server_id = ANY (v_removed_server_ids);
  END IF;

  IF v_approve AND NOT v_offline THEN
    -- Every action endpoint in force on a published App is reviewed (RFC 076
    -- §4, requireActionEndpointReviewOnPublish): one set before publishing
    -- waits for review like any later change, a newer pending one wins, and
    -- a new link-preview revision voids outstanding card handles.
    SELECT p.action_endpoint, p.pending_action_endpoint
      INTO v_link
      FROM public.oauth_app_link_previews p
      WHERE p.client_id = p_client_id
      FOR UPDATE;
    IF FOUND AND v_link.action_endpoint IS NOT NULL THEN
      UPDATE public.oauth_app_link_previews SET
        action_endpoint = NULL,
        pending_action_endpoint = coalesce(v_link.pending_action_endpoint, v_link.action_endpoint),
        pending_action_endpoint_requested_at = v_now,
        action_endpoint_reject_reason = NULL,
        revision = pg_catalog.gen_random_uuid(),
        updated_at = v_now
      WHERE client_id = p_client_id;
      v_endpoint_to_review := true;
      INSERT INTO public.integration_audit_events (
        id, server_id, client_id, event_type, event_category, outcome, source,
        actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
      ) VALUES (
        pg_catalog.gen_random_uuid(), v_client.server_id, p_client_id, 'app.action_endpoint_requested', 'registration', 'success', 'api',
        p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id,
        pg_catalog.jsonb_build_object('clientKey', v_client.client_id)
      );
    END IF;

    INSERT INTO public.oauth_client_installs (
      id, server_id, client_id, installed_by_user_id, approved_request_revision_id, approved_groups,
      grant_revision, approved_scopes, confirmed_text_revision_id, text_confirmed_by_user_id, text_confirmed_at
    ) VALUES (
      pg_catalog.gen_random_uuid(), v_client.server_id, p_client_id, v_client.created_by_user_id,
      v_client.outbound_current_revision_id, v_client.outbound_current_groups,
      CASE WHEN v_client.outbound_current_revision_id IS NULL THEN 0 ELSE 1 END,
      v_effective_scopes, v_text_revision_id, NULL, v_now
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_installed_count = ROW_COUNT;

    -- An existing source installation keeps its approved login scopes. The
    -- reviewer approves the listing, not that Server's installation: only a
    -- human who is owner or admin there (manageIntegrations) brings them up to
    -- date (approveSourceInstallationScopesForAdmin); otherwise the App's
    -- admins approve the update in Settings.
    IF v_installed_count = 0 AND p_actor_type = 'human' AND EXISTS (
      SELECT 1
        FROM public.server_members m
        JOIN public.servers s ON s.id = m.server_id
        WHERE m.server_id = v_client.server_id AND m.user_id = p_actor_id
          AND s.deleted_at IS NULL AND m.role IN ('owner', 'admin')
    ) THEN
      SELECT i.id, i.approved_scopes, i.approved_groups, i.grant_revision
        INTO v_source
        FROM public.oauth_client_installs i
        WHERE i.client_id = p_client_id AND i.server_id = v_client.server_id AND i.status = 'active'
        FOR UPDATE;
      IF FOUND AND (
        (SELECT count(DISTINCT scope) FROM pg_catalog.jsonb_array_elements_text(v_source.approved_scopes) scope)
          <> pg_catalog.jsonb_array_length(v_effective_scopes)
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_effective_scopes) wanted(scope)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements_text(v_source.approved_scopes) held(scope)
            WHERE held.scope = wanted.scope
          )
        )
      ) THEN
        UPDATE public.oauth_client_installs SET approved_scopes = v_effective_scopes, updated_at = v_now
          WHERE id = v_source.id;
        INSERT INTO public.integration_audit_events (
          id, server_id, client_id, event_type, event_category, outcome, source,
          actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
        ) VALUES (
          pg_catalog.gen_random_uuid(), v_client.server_id, p_client_id, 'installation.outbound_grant_updated', 'scope', 'success', 'api',
          'human', p_actor_id, 'app', p_client_id, 'installation', v_source.id,
          pg_catalog.jsonb_build_object(
            'clientKey', v_client.client_id,
            'installationId', v_source.id,
            'grantRevision', v_source.grant_revision,
            'groupCount', pg_catalog.jsonb_array_length(v_source.approved_groups),
            'approvedScopes', v_effective_scopes
          )
        );
      END IF;
    END IF;
  END IF;

  -- The decision's own audit event; metadata keys are integrationAuditService's
  -- allowlist for the event type.
  v_metadata := pg_catalog.jsonb_build_object(
    'clientKey', v_client.client_id,
    'appType', v_next_app_type,
    'previousPublishStatus', v_client.publish_status,
    'nextPublishStatus', v_next_status
  );
  IF v_approve AND v_offline THEN
    v_metadata := v_metadata || pg_catalog.jsonb_build_object(
      'removedInstallCount', v_removed_install_count,
      'revokedGrantCount', v_revoked_grant_count,
      'revokedTokenCount', v_revoked_token_count,
      'deniedPendingRequestCount', v_denied_request_count
    );
  ELSIF v_approve THEN
    v_metadata := v_metadata || pg_catalog.jsonb_build_object('installedCount', v_installed_count);
  END IF;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_client.server_id, p_client_id,
    CASE
      WHEN v_offline AND v_approve THEN 'app.offline_approved'
      WHEN v_offline THEN 'app.offline_rejected'
      WHEN v_approve THEN 'app.publish_approved'
      ELSE 'app.publish_rejected'
    END,
    CASE WHEN v_offline THEN 'revocation' ELSE 'registration' END,
    'success', 'api', p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id, v_metadata
  );

  RETURN pg_catalog.jsonb_build_object(
    'clientId', p_client_id,
    'previousStatus', v_client.publish_status,
    'status', v_next_status,
    'sourceInstallCreated', v_installed_count > 0,
    'actionEndpointToReview', v_endpoint_to_review,
    'removedInstallIds', pg_catalog.to_jsonb(v_removed_install_ids),
    'removedBots', v_removed_bots,
    'deniedRequestCount', v_denied_request_count,
    'revokedGrantCount', v_revoked_grant_count,
    'revokedTokenCount', v_revoked_token_count
  );
END
$marketplace_decide_publish_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_decide_publish_review(uuid, text, text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- App Admin's role (app_admin_operator) may run the decision and nothing
-- else: schema USAGE and EXECUTE on that one function, no table privilege.
-- The role is created by a person with Neon admin, not here; until it exists
-- this returns false and writes nothing. The server deploy calls it after
-- migrations (scripts/verify-app-admin-privileges.ts) and reads back the
-- receipt and the role's effective privileges.
CREATE FUNCTION public.reconcile_app_admin_privileges()
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
  GRANT EXECUTE ON FUNCTION public.marketplace_decide_publish_review(uuid, text, text, text, uuid, text) TO app_admin_operator;

  INSERT INTO public.app_admin_privilege_receipts (contract_key, migration_tag, applied_at, applied_by)
  VALUES ('marketplace-review-v1', '0476_marketplace_publish_review_fn', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
