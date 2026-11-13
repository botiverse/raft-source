-- RFC 084 step 3: a listed or official App's client id is changed by a person
-- who is a Botiverse owner or admin, in App Admin (#proj-apps:#57). App Admin
-- runs on a role that can only EXECUTE functions, so the rename is a database
-- function, and there is one of it:
--
-- - public.oauth_client_change_key: the rename itself (locks, the taken check,
--   the alias, the official registry row, the open link-card rows, the audit
--   event). Owner-only, called by Raft's routes after their own refusals and by
--   the entry below, as the marketplace decision bodies are. Refusals are
--   CKY01 no such App, CKY02 invalid id, CKY03 id taken, CKY04 alias limit (20,
--   OAUTH_CLIENT_MAX_ALIASES), and change nothing. An unchanged id answers
--   changed = false and writes nothing.
-- - public.app_admin_change_client_key: App Admin's entry. The same gate as the
--   review entries, then RVW01 bad argument or missing note, RVW02 no such App,
--   RVW04 an App in review or a key whose legacy scopes would be lost, RVW05
--   the id isn't the one shown. A reviewed rename always keeps the old id as an
--   alias.
-- - public.oauth_client_legacy_scope_keys: the keys on
--   LEGACY_OAUTH_SCOPE_ALLOWLIST, which SQL can't read; a test keeps them equal.
-- - The reconciler, redefined in full (contract app-admin-functions-v7): the
--   entry joins the role's functions; the body and the list are revoked by name.
--
-- Locks: new functions take no table lock. The reconciler only runs after the
-- migrations, and until the role exists it does nothing.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE FUNCTION public.oauth_client_legacy_scope_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $oauth_client_legacy_scope_keys$
  SELECT ARRAY['linkerdog-796e47', 'local-collabdoc-1', 'winbox', 'winbox-315c18']::text[]
$oauth_client_legacy_scope_keys$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.oauth_client_legacy_scope_keys() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.oauth_client_change_key(
  p_client_id uuid,
  p_new_key text,
  p_keep_old_key boolean,
  p_actor_type text,
  p_actor_id uuid,
  p_source text,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $oauth_client_change_key$
DECLARE
  v_old_key text;
  v_server_id uuid;
  v_new_key text := pg_catalog.lower(pg_catalog.btrim(p_new_key));
  v_alias_owner uuid;
  v_alias_exists boolean;
  v_own_alias boolean;
  v_aliases integer;
BEGIN
  -- The App's row first and the keys after it, as a delete does, so the two can't deadlock.
  SELECT client_id, server_id INTO v_old_key, v_server_id
    FROM public.oauth_clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such App' USING ERRCODE = 'CKY01';
  END IF;
  IF v_new_key IS NULL OR v_new_key !~ '^[a-z][a-z0-9-]{2,63}$' THEN
    RAISE EXCEPTION 'invalid client id' USING ERRCODE = 'CKY02';
  END IF;
  IF v_new_key = v_old_key THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'oldKey', v_old_key, 'newKey', v_new_key, 'previousKeyKept', false);
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('oauth-client-key:' || LEAST(v_old_key, v_new_key), 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('oauth-client-key:' || GREATEST(v_old_key, v_new_key), 0));

  SELECT client_id, true INTO v_alias_owner, v_alias_exists
    FROM public.oauth_client_key_aliases WHERE key = v_new_key;
  v_alias_exists := COALESCE(v_alias_exists, false);
  v_own_alias := v_alias_exists AND v_alias_owner IS NOT DISTINCT FROM p_client_id;
  -- A tombstone is reclaimed only by registering a new App (RFC 084 §3.5).
  IF (v_alias_exists AND NOT v_own_alias)
     OR EXISTS (SELECT 1 FROM public.oauth_clients WHERE client_id = v_new_key) THEN
    RAISE EXCEPTION 'client id is taken' USING ERRCODE = 'CKY03';
  END IF;

  SELECT count(*) INTO v_aliases FROM public.oauth_client_key_aliases WHERE client_id = p_client_id;
  IF v_aliases - (CASE WHEN v_own_alias THEN 1 ELSE 0 END) + (CASE WHEN p_keep_old_key THEN 1 ELSE 0 END) > 20 THEN
    RAISE EXCEPTION 'alias limit reached' USING ERRCODE = 'CKY04';
  END IF;

  IF v_own_alias THEN
    DELETE FROM public.oauth_client_key_aliases WHERE key = v_new_key;
  END IF;
  -- One statement: the registry row's foreign key names the App's key.
  WITH registry AS (
    UPDATE public.official_app_registry
       SET client_key = v_new_key, revision = revision + 1, updated_at = pg_catalog.now(),
           updated_by_user_id = CASE WHEN p_actor_type = 'human' THEN p_actor_id ELSE updated_by_user_id END
     WHERE oauth_client_id = p_client_id
    RETURNING 1
  )
  UPDATE public.oauth_clients SET client_id = v_new_key, updated_at = pg_catalog.now()
   WHERE id = p_client_id;
  IF p_keep_old_key THEN
    INSERT INTO public.oauth_client_key_aliases (key, client_id, source_server_id)
    VALUES (v_old_key, p_client_id, v_server_id);
  END IF;

  -- Link-card rows that are still open follow the App to its new id. A live
  -- token's operation moves with it, even a terminal one, because accepting
  -- the update compares the token's key with the operation's.
  WITH live_tokens AS (
    UPDATE public.link_card_update_tokens SET provider_key = v_new_key
     WHERE provider_kind = 'app' AND provider_key = v_old_key AND expires_at > pg_catalog.clock_timestamp()
    RETURNING operation_id
  ), moved_operations AS (
    UPDATE public.link_card_operations SET provider_key = v_new_key
     WHERE provider_kind = 'app' AND provider_key = v_old_key
       AND (state NOT IN ('done', 'refused', 'failed_not_sent', 'resolved_manually')
            OR operation_id IN (SELECT operation_id FROM live_tokens))
    RETURNING operation_id
  )
  UPDATE public.link_card_client_requests request SET provider_key = v_new_key
    FROM moved_operations
   WHERE request.operation_id = moved_operations.operation_id
     AND request.provider_kind = 'app' AND request.provider_key = v_old_key
     AND NOT EXISTS (
       SELECT 1 FROM public.link_card_client_requests taken
        WHERE taken.provider_kind = 'app' AND taken.provider_key = v_new_key
          AND taken.viewer_id = request.viewer_id AND taken.server_id = request.server_id
          AND taken.installation_key = request.installation_key AND taken.client_request_id = request.client_request_id
     );
  UPDATE public.link_card_views SET provider_key = v_new_key WHERE provider_kind = 'app' AND provider_key = v_old_key;

  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_server_id, p_client_id,
    'app.client_key_changed', 'registration', 'success', p_source,
    p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'clientKey', v_new_key, 'previousClientKey', v_old_key, 'newClientKey', v_new_key,
      'previousKeyKept', p_keep_old_key, 'reviewNote', p_note
    ))
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'oldKey', v_old_key, 'newKey', v_new_key, 'previousKeyKept', p_keep_old_key);
END
$oauth_client_change_key$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.oauth_client_change_key(uuid, text, boolean, text, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_change_client_key(
  p_client_id uuid,
  p_expected_key text,
  p_new_key text,
  p_actor_type text,
  p_actor_id uuid,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_change_client_key$
DECLARE
  v_current text;
  v_publish_status text;
  v_note text := pg_catalog.btrim(p_note);
BEGIN
  PERFORM public.marketplace_review_require_decider(p_actor_type, p_actor_id);
  IF p_client_id IS NULL OR p_expected_key IS NULL OR p_new_key IS NULL
     OR v_note IS NULL OR pg_catalog.length(v_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'the App, the id shown, the new id and a note are required' USING ERRCODE = 'RVW01';
  END IF;
  SELECT client_id, publish_status INTO v_current, v_publish_status
    FROM public.oauth_clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such App' USING ERRCODE = 'RVW02';
  END IF;
  IF v_current <> p_expected_key THEN
    RAISE EXCEPTION 'the client id changed since it was shown' USING ERRCODE = 'RVW05',
      DETAIL = pg_catalog.jsonb_build_object('currentKey', v_current)::text;
  END IF;
  IF v_publish_status IN ('publish_requested', 'in_review') THEN
    RAISE EXCEPTION 'an App in review can''t change its client id until it is decided' USING ERRCODE = 'RVW04';
  END IF;
  IF v_current = ANY (public.oauth_client_legacy_scope_keys())
     OR pg_catalog.lower(pg_catalog.btrim(p_new_key)) = ANY (public.oauth_client_legacy_scope_keys()) THEN
    RAISE EXCEPTION 'this client id carries legacy scopes tied to the id itself' USING ERRCODE = 'RVW04';
  END IF;
  RETURN public.oauth_client_change_key(p_client_id, p_new_key, true, 'human', p_actor_id, 'web', v_note);
END
$app_admin_change_client_key$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_change_client_key(uuid, text, text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
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
  REVOKE ALL PRIVILEGES ON FUNCTION public.mcp_app_template_admin_entry(public.mcp_app_templates) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.oauth_client_change_key(uuid, text, boolean, text, uuid, text, text) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.oauth_client_legacy_scope_keys() FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_change_client_key(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_change_client_key(uuid, text, text, text, uuid, text) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_create_mcp_app_template(text, text, text, text, text, text, text, text, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_create_mcp_app_template(text, text, text, text, text, text, text, text, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_update_mcp_app_template(uuid, integer, text, text, text, text, text, text, text, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_update_mcp_app_template(uuid, integer, text, text, text, text, text, text, text, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_retire_mcp_app_template(uuid, integer, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_retire_mcp_app_template(uuid, integer, uuid, text, uuid) TO app_admin_operator;

  -- Revoking a table's privileges revokes its column privileges too, so a
  -- column a later contract drops from this list does not linger.
  REVOKE ALL PRIVILEGES ON TABLE public.external_app_registrations FROM app_admin_operator;
  GRANT SELECT ("oauth_client_id") ON TABLE public.external_app_registrations TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.integration_audit_events FROM app_admin_operator;
  GRANT SELECT ("id", "server_id", "client_id", "event_type", "event_category", "outcome", "source", "actor_type", "actor_id", "requester_type", "requester_id", "subject_type", "subject_id", "target_type", "target_id", "correlation_id", "request_id", "metadata", "diff", "created_at") ON TABLE public.integration_audit_events TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.mcp_app_templates FROM app_admin_operator;
  GRANT SELECT ("id", "key", "name", "description", "homepage_url", "logo_url", "category", "endpoint_url", "auth_kind", "status", "revision", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at") ON TABLE public.mcp_app_templates TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_access_requests FROM app_admin_operator;
  GRANT SELECT ("id", "client_id", "server_id", "principal_type", "user_id", "agent_id", "status", "consumed_at", "created_at") ON TABLE public.oauth_access_requests TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_access_tokens FROM app_admin_operator;
  GRANT SELECT ("request_id", "created_at") ON TABLE public.oauth_access_tokens TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_app_link_previews FROM app_admin_operator;
  GRANT SELECT ("client_id", "origin", "action_endpoint", "pending_action_endpoint", "pending_action_endpoint_requested_at", "action_endpoint_reject_reason", "verified_at", "suspended_at") ON TABLE public.oauth_app_link_previews TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_app_permission_revisions FROM app_admin_operator;
  GRANT SELECT ("id", "client_id", "revision", "requested_groups", "requested_events", "state", "created_by_type", "created_at") ON TABLE public.oauth_app_permission_revisions TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_client_installs FROM app_admin_operator;
  GRANT SELECT ("client_id", "server_id") ON TABLE public.oauth_client_installs TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.oauth_clients FROM app_admin_operator;
  GRANT SELECT ("id", "server_id", "client_id", "app_type", "name", "description", "homepage_url", "return_url", "agent_manifest_url", "logo_url", "logo_storage_key", "category", "enabled", "human_marketplace_visible", "publish_status", "publish_requested_at", "publish_reviewed_at", "publish_reviewed_by_user_id", "publish_rejection_reason", "created_by_user_id", "outbound_pending_revision_id", "outbound_current_groups", "outbound_current_events", "created_at", "updated_at") ON TABLE public.oauth_clients TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.official_app_registry FROM app_admin_operator;
  GRANT SELECT ("oauth_client_id", "client_key", "publisher_server_id", "auto_install", "purpose", "status", "revision", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at") ON TABLE public.official_app_registry TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.server_members FROM app_admin_operator;
  GRANT SELECT ("server_id", "user_id", "role") ON TABLE public.server_members TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.servers FROM app_admin_operator;
  GRANT SELECT ("id", "name", "slug", "deleted_at") ON TABLE public.servers TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.users FROM app_admin_operator;
  GRANT SELECT ("id", "name", "display_name", "retired_at") ON TABLE public.users TO app_admin_operator;

  INSERT INTO public.app_admin_privilege_receipts (contract_key, migration_tag, applied_at, applied_by)
  VALUES ('app-admin-functions-v7', '0645_oauth_client_change_key', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
