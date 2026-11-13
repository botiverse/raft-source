-- What a marketplace review decision does after the database
-- (#proj-apps:#50). App Admin decides reviews through the gated entries of
-- 0562/0564, straight against Postgres; the server's review routes called the
-- same decision bodies and then did two things App Admin's path never did:
--
-- 1. After a permission approval the route put the source installation's own
--    events (installation.bot_changed) back into its subscription, which the
--    body had set to exactly the reviewed events. The body now keeps them
--    itself; the route's step is gone.
-- 2. After commit the route emitted `agent:deleted` and the credential
--    revocation signal for each bot an offline approval removed, and
--    `permission-updates:changed` for every Server the App was installed on
--    (publish/offline decisions and permission approvals). A database
--    function cannot emit, so the bodies now write those as rows of
--    marketplace_review_outbox in the decision's own transaction, and the
--    server delivers them (services/marketplaceReviewOutbox.ts), whoever
--    decided. The server's routes deliver their own decision's rows before
--    they answer, and the worker delivers the rest (every replica polls).
--
-- Security does not wait for the outbox: an offline approval already revoked
-- the removed bots' credentials (revoked_at, reason bot_uninstalled), marked
-- their bindings uninstalled, soft-deleted their agents and deleted the
-- installations (cascading the bindings away) inside the function, since 0476;
-- this migration keeps that unchanged. The signal only closes streams that
-- were open, which re-validate against the database anyway.
--
-- Also here:
-- - public.marketplace_permission_review_keeps_bot_changed(), a marker App
--   Admin looks up with to_regprocedure before it resumes permission
--   approvals (no EXECUTE needed for the lookup; owner-only like the bodies).
-- - A one-off repair of installations an App Admin approval may have left
--   without installation.bot_changed before this migration (a guard: no
--   approval through App Admin's entry is known, so it should change no
--   row). See the statement.
-- - The reconciler, redefined in full (contract app-admin-functions-v5):
--   App Admin's role still executes exactly the three review entries and the
--   two registry functions; the marker is revoked from it by name. The outbox
--   table is the server's (it connects as the owner); App Admin's role gets
--   nothing on it, which the deploy's privilege check verifies.
--
-- The card URL review (marketplace_decide_action_endpoint_review) had nothing
-- after it and is unchanged.
--
-- Locks: the new table is empty; the function replacements take no table
-- lock; the repair updates a few oauth_client_installs rows at most.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "marketplace_review_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "marketplace_review_outbox_kind_valid" CHECK ("marketplace_review_outbox"."kind" IN ('app_bot_removed', 'permission_updates_changed')),
	CONSTRAINT "marketplace_review_outbox_agent_for_bot" CHECK (("marketplace_review_outbox"."kind" = 'app_bot_removed') = ("marketplace_review_outbox"."agent_id" IS NOT NULL)),
	CONSTRAINT "marketplace_review_outbox_attempts_nonnegative" CHECK ("marketplace_review_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_marketplace_review_outbox_seq" ON "marketplace_review_outbox" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "idx_marketplace_review_outbox_undelivered" ON "marketplace_review_outbox" USING btree ("client_id","seq") WHERE delivered_at IS NULL;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.marketplace_review_outbox FROM PUBLIC;
--> statement-breakpoint
-- The publish/offline decision body of 0476, unchanged but for its outbox
-- rows: one app_bot_removed per bot an offline approval removed (its Server,
-- its agent), then one permission_updates_changed per Server the App was
-- installed on before the decision, for every decision (approve or reject,
-- publish or offline). `cause` is the decision's audit event type. The
-- result is unchanged (removedBots stays in it).
CREATE OR REPLACE FUNCTION public.marketplace_decide_publish_review(
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
  v_event_type text;
  v_installed_server_ids uuid[];
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

  -- Every Server the App is installed on, read before the decision removes
  -- any installation: each is told its permission updates may have changed
  -- (what the server's route announced, reading them at this point).
  SELECT coalesce(pg_catalog.array_agg(DISTINCT i.server_id ORDER BY i.server_id), '{}')
    INTO v_installed_server_ids
    FROM public.oauth_client_installs i
    WHERE i.client_id = p_client_id;

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
  v_event_type := CASE
    WHEN v_offline AND v_approve THEN 'app.offline_approved'
    WHEN v_offline THEN 'app.offline_rejected'
    WHEN v_approve THEN 'app.publish_approved'
    ELSE 'app.publish_rejected'
  END;
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
    v_event_type,
    CASE WHEN v_offline THEN 'revocation' ELSE 'registration' END,
    'success', 'api', p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id, v_metadata
  );

  -- What follows outside the database, delivered by the server after the
  -- commit whoever decided (marketplace_review_outbox): each removed bot's
  -- Server is told it is gone and its open credential streams close (the
  -- credentials were revoked above), then every Server the App was installed
  -- on is told its permission updates may have changed.
  INSERT INTO public.marketplace_review_outbox (client_id, kind, server_id, agent_id, cause)
  SELECT p_client_id, 'app_bot_removed', (removed.bot ->> 'serverId')::uuid, (removed.bot ->> 'agentId')::uuid, v_event_type
    FROM pg_catalog.jsonb_array_elements(v_removed_bots) WITH ORDINALITY AS removed(bot, n)
    ORDER BY removed.n;
  INSERT INTO public.marketplace_review_outbox (client_id, kind, server_id, cause)
  SELECT p_client_id, 'permission_updates_changed', installed.server_id, v_event_type
    FROM pg_catalog.unnest(v_installed_server_ids) WITH ORDINALITY AS installed(server_id, n)
    ORDER BY installed.n;

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
-- The permission approval body of 0564 with the source installation keeping
-- its own events, and one permission_updates_changed outbox row per Server
-- the App is installed on (cause app.outbound_permission_approved). Its
-- arguments, refusals and result are unchanged.
CREATE OR REPLACE FUNCTION public.marketplace_approve_permission_review(
  p_client_id uuid,
  p_expected_revision_id uuid,
  p_reviewer_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $marketplace_approve_permission_review$
DECLARE
  -- The installation's own events: APP_INSTALLATION_NOTIFICATION_EVENTS
  -- (packages/shared/src/appNotifications.ts), never declared by an App.
  c_installation_events CONSTANT text[] := ARRAY['installation.bot_changed'];
  v_now timestamptz := pg_catalog.now();
  v_client record;
  v_revision record;
  v_install record;
  v_groups_changed boolean;
  v_events_changed boolean;
  v_kept_events jsonb;
  v_next_events jsonb;
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
  -- server did. Its subscription becomes the revision's events plus the
  -- installation's own events it had (installation.bot_changed), which no
  -- revision lists: the server put them back after this function until now.
  -- With none kept the revision's list goes in as stored; with some, the
  -- union, sorted (byte order) and without duplicates, as the server wrote
  -- it. Changed: the installation's list, sorted, is not the list written
  -- element for element (for events, the list with the kept ones, as
  -- createAppOutboundPermissionRevision compares).
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
    SELECT pg_catalog.jsonb_agg(e.value)
      INTO v_kept_events
      FROM pg_catalog.jsonb_array_elements(v_install.subscribed_events) AS e
      WHERE (e.value #>> '{}') = ANY (c_installation_events);
    IF v_kept_events IS NULL THEN
      v_next_events := v_revision.requested_events;
    ELSE
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(merged.name) ORDER BY merged.name COLLATE "C")
        INTO v_next_events
        FROM (
          SELECT DISTINCT e.value #>> '{}' AS name
            FROM pg_catalog.jsonb_array_elements(v_revision.requested_events || v_kept_events) AS e
        ) merged;
    END IF;
    v_events_changed := coalesce(
      (SELECT pg_catalog.jsonb_agg(e.value ORDER BY (e.value #>> '{}') COLLATE "C")
         FROM pg_catalog.jsonb_array_elements(v_install.subscribed_events) AS e),
      '[]'::jsonb
    ) IS DISTINCT FROM v_next_events;
    UPDATE public.oauth_client_installs SET
      approved_request_revision_id = v_revision.id,
      approved_groups = v_revision.requested_groups,
      grant_revision = CASE WHEN v_groups_changed THEN v_install.grant_revision + 1 ELSE v_install.grant_revision END,
      subscribed_events = v_next_events,
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

  -- What follows outside the database, delivered by the server after the
  -- commit whoever approved (marketplace_review_outbox): every Server the App
  -- is installed on is told its permission updates may have changed.
  INSERT INTO public.marketplace_review_outbox (client_id, kind, server_id, cause)
  SELECT v_client.id, 'permission_updates_changed', installed.server_id, 'app.outbound_permission_approved'
    FROM (SELECT DISTINCT i.server_id FROM public.oauth_client_installs i WHERE i.client_id = v_client.id) installed
    ORDER BY installed.server_id;

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
-- App Admin's guard (App Admin #50) resumes permission approvals once this
-- exists: it looks it up with to_regprocedure, which needs no EXECUTE. It
-- exists exactly when the permission body keeps installation.bot_changed and
-- writes its outbox rows (this migration). Owner-only, like the bodies.
CREATE FUNCTION public.marketplace_permission_review_keeps_bot_changed()
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $marketplace_permission_review_keeps_bot_changed$
  SELECT true
$marketplace_permission_review_keeps_bot_changed$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_permission_review_keeps_bot_changed() FROM PUBLIC;
--> statement-breakpoint
-- One-off repair, a guard: give installation.bot_changed back to a source
-- installation an approval through App Admin's entry left without it. App
-- Admin is known to have approved none (8 pending, its approvals paused until
-- the marker above exists), so this should change no row.
--
-- Nothing records whether an installation subscribed to the event before an
-- approval, or which caller approved, so the statement takes only what such
-- an approval leaves and nothing written since could explain:
-- - an active installation on the App's own Server, of a user-managed App;
-- - whose approved revision is the App's current one, approved by a review
--   (state active, reviewed_at set) no earlier than 2026-11-02 20:52:00.914
--   UTC: the journal `when` of 0564, before which no database had App
--   Admin's permission entry, and the server's route kept the event;
-- - last written by that approval and nothing since: updated_at equals
--   reviewed_at (both the approving transaction's now()) and the
--   subscription is exactly the revision's events as stored;
-- - without installation.bot_changed.
-- A server-route approval since that date of a source installation that never
-- subscribed, untouched since, looks the same and would be subscribed too.
-- Count before release (the same predicates as a SELECT count(*)); a non-zero
-- count needs a person.
--
-- Written as the route wrote it (the union, sorted, no duplicates); the
-- subscription revision stays, as the route left it.
UPDATE public.oauth_client_installs i SET
  subscribed_events = (
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(merged.name) ORDER BY merged.name COLLATE "C")
      FROM (
        SELECT DISTINCT e.value #>> '{}' AS name
          FROM pg_catalog.jsonb_array_elements(i.subscribed_events || '["installation.bot_changed"]'::jsonb) AS e
      ) merged
  ),
  updated_at = pg_catalog.now()
FROM public.oauth_clients c, public.oauth_app_permission_revisions r
WHERE c.id = i.client_id
  AND i.server_id = c.server_id
  AND i.status = 'active'
  AND c.app_type <> 'slock_builtin'
  AND NOT EXISTS (SELECT 1 FROM public.external_app_registrations x WHERE x.oauth_client_id = c.id)
  AND r.id = i.approved_request_revision_id
  AND r.id = c.outbound_current_revision_id
  AND r.client_id = c.id
  AND r.state = 'active'
  AND r.reviewed_at IS NOT NULL
  AND r.reviewed_at >= '2026-11-02 20:52:00.914+00'::timestamptz
  AND i.updated_at = r.reviewed_at
  AND i.subscribed_events = r.requested_events
  AND NOT (i.subscribed_events @> '["installation.bot_changed"]'::jsonb);
--> statement-breakpoint
-- Redefined in full, as each App Admin contract migration does: App Admin's
-- role may use schema public and execute the three review entries and the two
-- registry functions, nothing else. The bodies, the gate and now the marker
-- are revoked by name, so a stray grant cannot survive a deploy. Until the
-- role exists this returns false and writes nothing; the server deploy runs
-- it after migrations (scripts/verify-app-admin-privileges.ts) and reads back
-- the receipt and the role's effective privileges (no privilege on
-- marketplace_review_outbox or its sequence, like every other relation).
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
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_permission_review_keeps_bot_changed() FROM app_admin_operator;
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
  VALUES ('app-admin-functions-v5', '0625_marketplace_review_outbox', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
