-- schema-snapshot: unchanged (functions and grants only; no Drizzle-declared schema changes)
-- Add separate MCP template entries for human and Agent administrators. Existing
-- review and human-only template entries remain unchanged. The caller is a
-- sensitive, trusted App Admin role; every entry rechecks and locks authority.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE FUNCTION public.mcp_template_require_manager(p_actor_type text, p_actor_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp
AS $gate$
DECLARE
  c_server CONSTANT uuid := '95f993fa-2a68-4797-b8ae-7beb7d984ada';
BEGIN
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor type and id required' USING ERRCODE = 'RVW01';
  END IF;
  PERFORM 1 FROM public.servers WHERE id = c_server AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'server unavailable' USING ERRCODE = 'RVW07'; END IF;
  IF p_actor_type = 'human' THEN
    PERFORM 1 FROM public.users WHERE id = p_actor_id AND retired_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'actor unavailable' USING ERRCODE = 'RVW07'; END IF;
    PERFORM 1 FROM public.server_members WHERE server_id = c_server AND user_id = p_actor_id
      AND role IN ('owner', 'admin') FOR SHARE;
  ELSE
    PERFORM 1 FROM public.agents WHERE id = p_actor_id AND server_id = c_server AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'actor unavailable' USING ERRCODE = 'RVW07'; END IF;
    PERFORM 1 FROM public.server_agent_members WHERE server_id = c_server AND agent_id = p_actor_id
      AND role = 'admin' FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'template management requires a Botiverse administrator' USING ERRCODE = 'RVW07'; END IF;
END
$gate$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.mcp_template_require_manager(text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.mcp_app_template_admin_entry_v2(p_template public.mcp_app_templates)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $mcp_app_template_admin_entry_v2$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_template.id,
    'key', p_template.key,
    'name', p_template.name,
    'description', p_template.description,
    'homepageUrl', p_template.homepage_url,
    'logoUrl', p_template.logo_url,
    'category', p_template.category,
    'endpointUrl', p_template.endpoint_url,
    'authKind', p_template.auth_kind,
    'oauthClientMode', p_template.oauth_client_mode,
    'status', p_template.status,
    'revision', p_template.revision,
    'createdByUserId', p_template.created_by_user_id,
    'updatedByUserId', p_template.updated_by_user_id,
    'createdAt', p_template.created_at,
    'updatedAt', p_template.updated_at
  )
$mcp_app_template_admin_entry_v2$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.mcp_app_template_admin_entry_v2(public.mcp_app_templates) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_create_mcp_app_template_v2(
  p_key text,
  p_name text,
  p_description text,
  p_homepage_url text,
  p_logo_url text,
  p_category text,
  p_endpoint_url text,
  p_auth_kind text,
  p_oauth_client_mode text,
  p_audit_server_id uuid,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_create_mcp_app_template_v2$
DECLARE
  v_template public.mcp_app_templates%ROWTYPE;
BEGIN
  PERFORM public.mcp_template_require_manager(p_actor_type, p_actor_id);
  IF p_audit_server_id IS NULL THEN
    RAISE EXCEPTION 'the Server to audit under is required' USING ERRCODE = 'RVW01';
  END IF;
  INSERT INTO public.mcp_app_templates (
    id, key, name, description, homepage_url, logo_url, category,
    endpoint_url, auth_kind, oauth_client_mode, status, created_by_user_id, updated_by_user_id
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_key, p_name, p_description, p_homepage_url, p_logo_url, p_category,
    p_endpoint_url, p_auth_kind, p_oauth_client_mode, 'active', CASE WHEN p_actor_type = 'human' THEN p_actor_id END, CASE WHEN p_actor_type = 'human' THEN p_actor_id END
  )
  ON CONFLICT (key) DO NOTHING
  RETURNING * INTO v_template;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_audit_server_id, NULL,
    'mcp_app.template_created', 'registration', 'success', CASE WHEN p_actor_type = 'human' THEN 'web' ELSE 'api' END,
    p_actor_type, p_actor_id, 'system', NULL,
    'mcp_app_template', v_template.id,
    pg_catalog.jsonb_build_object(
      'key', v_template.key, 'name', v_template.name,
      'authKind', v_template.auth_kind, 'oauthClientMode', v_template.oauth_client_mode, 'category', v_template.category, 'revision', v_template.revision
    )
  );
  RETURN public.mcp_app_template_admin_entry_v2(v_template);
END
$app_admin_create_mcp_app_template_v2$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_create_mcp_app_template_v2(text, text, text, text, text, text, text, text, text, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_update_mcp_app_template_v2(
  p_id uuid,
  p_expected_revision integer,
  p_name text,
  p_description text,
  p_homepage_url text,
  p_logo_url text,
  p_category text,
  p_endpoint_url text,
  p_auth_kind text,
  p_oauth_client_mode text,
  p_audit_server_id uuid,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_update_mcp_app_template_v2$
DECLARE
  v_before public.mcp_app_templates%ROWTYPE;
  v_template public.mcp_app_templates%ROWTYPE;
BEGIN
  PERFORM public.mcp_template_require_manager(p_actor_type, p_actor_id);
  IF p_audit_server_id IS NULL THEN
    RAISE EXCEPTION 'the Server to audit under is required' USING ERRCODE = 'RVW01';
  END IF;
  SELECT * INTO v_before
    FROM public.mcp_app_templates
    WHERE id = p_id AND revision = p_expected_revision
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE public.mcp_app_templates
    SET name = p_name, description = p_description,
        homepage_url = p_homepage_url, logo_url = p_logo_url,
        category = p_category, endpoint_url = p_endpoint_url,
        auth_kind = p_auth_kind, oauth_client_mode = p_oauth_client_mode,
        revision = revision + 1, updated_by_user_id = CASE WHEN p_actor_type = 'human' THEN p_actor_id END, updated_at = pg_catalog.now()
    WHERE id = p_id
    RETURNING * INTO v_template;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata, diff
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_audit_server_id, NULL,
    'mcp_app.template_updated', 'registration', 'success', CASE WHEN p_actor_type = 'human' THEN 'web' ELSE 'api' END,
    p_actor_type, p_actor_id, 'system', NULL,
    'mcp_app_template', v_template.id,
    pg_catalog.jsonb_build_object('key', v_template.key, 'revision', v_template.revision),
    pg_catalog.jsonb_build_object(
      'name', pg_catalog.jsonb_build_object('before', v_before.name, 'after', v_template.name),
      'description', pg_catalog.jsonb_build_object('before', v_before.description, 'after', v_template.description),
      'endpointChanged', v_before.endpoint_url IS DISTINCT FROM v_template.endpoint_url,
      'authKind', pg_catalog.jsonb_build_object('before', v_before.auth_kind, 'after', v_template.auth_kind),
      'oauthClientMode', pg_catalog.jsonb_build_object('before', v_before.oauth_client_mode, 'after', v_template.oauth_client_mode),
      'category', pg_catalog.jsonb_build_object('before', v_before.category, 'after', v_template.category),
      'homepageUrl', pg_catalog.jsonb_build_object('before', v_before.homepage_url, 'after', v_template.homepage_url),
      'logoUrl', pg_catalog.jsonb_build_object('before', v_before.logo_url, 'after', v_template.logo_url)
    )
  );
  RETURN public.mcp_app_template_admin_entry_v2(v_template);
END
$app_admin_update_mcp_app_template_v2$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_update_mcp_app_template_v2(uuid, integer, text, text, text, text, text, text, text, text, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_retire_mcp_app_template_v2(
  p_id uuid,
  p_expected_revision integer,
  p_audit_server_id uuid,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_retire_mcp_app_template_v2$
DECLARE
  v_template public.mcp_app_templates%ROWTYPE;
BEGIN
  PERFORM public.mcp_template_require_manager(p_actor_type, p_actor_id);
  IF p_audit_server_id IS NULL THEN
    RAISE EXCEPTION 'the Server to audit under is required' USING ERRCODE = 'RVW01';
  END IF;
  UPDATE public.mcp_app_templates
    SET status = 'retired', revision = revision + 1,
        updated_by_user_id = CASE WHEN p_actor_type = 'human' THEN p_actor_id END, updated_at = pg_catalog.now()
    WHERE id = p_id AND revision = p_expected_revision AND status = 'active'
    RETURNING * INTO v_template;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_audit_server_id, NULL,
    'mcp_app.template_retired', 'registration', 'success', CASE WHEN p_actor_type = 'human' THEN 'web' ELSE 'api' END,
    p_actor_type, p_actor_id, 'system', NULL,
    'mcp_app_template', v_template.id,
    pg_catalog.jsonb_build_object('key', v_template.key, 'revision', v_template.revision)
  );
  RETURN public.mcp_app_template_admin_entry_v2(v_template);
END
$app_admin_retire_mcp_app_template_v2$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_retire_mcp_app_template_v2(uuid, integer, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_restore_mcp_app_template_v2(
  p_id uuid,
  p_expected_revision integer,
  p_expected_endpoint text,
  p_audit_server_id uuid,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_restore_mcp_app_template_v2$
DECLARE
  v_template public.mcp_app_templates%ROWTYPE;
BEGIN
  PERFORM public.mcp_template_require_manager(p_actor_type, p_actor_id);
  IF p_audit_server_id IS NULL THEN
    RAISE EXCEPTION 'the Server to audit under is required' USING ERRCODE = 'RVW01';
  END IF;
  UPDATE public.mcp_app_templates
    SET status = 'active', revision = revision + 1,
        updated_by_user_id = CASE WHEN p_actor_type = 'human' THEN p_actor_id END, updated_at = pg_catalog.now()
    WHERE id = p_id AND revision = p_expected_revision AND status = 'retired' AND endpoint_url = p_expected_endpoint
    RETURNING * INTO v_template;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), p_audit_server_id, NULL,
    'mcp_app.template_restored', 'registration', 'success', CASE WHEN p_actor_type = 'human' THEN 'web' ELSE 'api' END,
    p_actor_type, p_actor_id, 'system', NULL,
    'mcp_app_template', v_template.id,
    pg_catalog.jsonb_build_object('key', v_template.key, 'revision', v_template.revision)
  );
  RETURN public.mcp_app_template_admin_entry_v2(v_template);
END
$app_admin_restore_mcp_app_template_v2$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_restore_mcp_app_template_v2(uuid, integer, text, uuid, text, uuid) FROM PUBLIC;
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

  REVOKE ALL PRIVILEGES ON FUNCTION public.mcp_template_require_manager(text, uuid) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.mcp_app_template_admin_entry_v2(public.mcp_app_templates) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_create_mcp_app_template_v2(text, text, text, text, text, text, text, text, text, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_create_mcp_app_template_v2(text, text, text, text, text, text, text, text, text, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_update_mcp_app_template_v2(uuid, integer, text, text, text, text, text, text, text, text, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_update_mcp_app_template_v2(uuid, integer, text, text, text, text, text, text, text, text, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_retire_mcp_app_template_v2(uuid, integer, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_retire_mcp_app_template_v2(uuid, integer, uuid, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_restore_mcp_app_template_v2(uuid, integer, text, uuid, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_restore_mcp_app_template_v2(uuid, integer, text, uuid, text, uuid) TO app_admin_operator;

  -- Revoking a table's privileges revokes its column privileges too, so a
  -- column a later contract drops from this list does not linger.
  REVOKE ALL PRIVILEGES ON TABLE public.external_app_registrations FROM app_admin_operator;
  GRANT SELECT ("oauth_client_id") ON TABLE public.external_app_registrations TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.integration_audit_events FROM app_admin_operator;
  GRANT SELECT ("id", "server_id", "client_id", "event_type", "event_category", "outcome", "source", "actor_type", "actor_id", "requester_type", "requester_id", "subject_type", "subject_id", "target_type", "target_id", "correlation_id", "request_id", "metadata", "diff", "created_at") ON TABLE public.integration_audit_events TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON TABLE public.mcp_app_templates FROM app_admin_operator;
  GRANT SELECT ("id", "key", "name", "description", "homepage_url", "logo_url", "category", "endpoint_url", "auth_kind", "oauth_client_mode", "status", "revision", "created_by_user_id", "updated_by_user_id", "created_at", "updated_at") ON TABLE public.mcp_app_templates TO app_admin_operator;
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
  VALUES ('app-admin-functions-v8', '0664_app_admin_mcp_template_agents', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
