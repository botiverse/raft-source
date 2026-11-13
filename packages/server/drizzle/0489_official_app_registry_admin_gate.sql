-- Official App registry writes need a person who is an owner or admin of
-- Botiverse at the moment of the write (Tenny ffd89637, artin f06f5ac1). Until
-- now App Admin decided who may call, from a reviewer allowlist in its Worker
-- configuration; App Admin's role is meant to end up with EXECUTE on these
-- functions and nothing else, so the membership check lives here, in the same
-- transaction as the write. App permission reviews already follow Botiverse
-- membership (slock-internal-app-admin #28); this is the same rule for the
-- registry, people only: "official" is a trust signal users see, and a person
-- grants it.
--
-- What changes, for both official_app_registry_register and _update:
--
-- - p_actor_type 'agent' is refused with ORG07 (it stays a valid argument, so
--   the call shape App Admin uses is unchanged).
-- - p_actor_type 'human' must have a server_members row in Botiverse
--   (95f993fa-2a68-4797-b8ae-7beb7d984ada, the platform's own Server; App
--   Admin pins the same id) with role owner or admin, on a Server that is not
--   deleted. The row is taken FOR SHARE before the App and the entry, so a
--   concurrent demotion or removal waits for this write, and a write that
--   starts after it sees the new role. Not a member, or a member/guest: ORG07.
-- - Unknown or retired users are still ORG01, checked first.
--
-- Signatures, return values, the other checks, the audit event and the
-- grants are unchanged (CREATE OR REPLACE keeps the functions' privileges, so
-- reconcile_app_admin_privileges() and its receipt need no new version). The
-- helper is invoker-rights and executable by no one but its owner, so App
-- Admin's role cannot call it and the privilege check is unaffected.
--
-- Errors (SQLSTATE class OR), adding:
--   ORG07 the actor may not change the official registry
CREATE FUNCTION public.official_app_registry_require_operator(
  p_actor_type text,
  p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $official_app_registry_require_operator$
DECLARE
  -- Botiverse, the platform's own Server.
  c_platform_server_id CONSTANT uuid := '95f993fa-2a68-4797-b8ae-7beb7d984ada';
BEGIN
  IF p_actor_type = 'agent' THEN
    RAISE EXCEPTION 'official registry changes are made by a person' USING ERRCODE = 'ORG07';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'ORG01';
  END IF;
  PERFORM 1
    FROM public.server_members m
    JOIN public.servers s ON s.id = m.server_id
    WHERE m.server_id = c_platform_server_id
      AND m.user_id = p_actor_id
      AND m.role IN ('owner', 'admin')
      AND s.deleted_at IS NULL
    FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'official registry changes need a Botiverse owner or admin' USING ERRCODE = 'ORG07';
  END IF;
  RETURN p_actor_id;
END
$official_app_registry_require_operator$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.official_app_registry_require_operator(text, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.official_app_registry_register(
  p_client_id uuid,
  p_purpose text,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $official_app_registry_register$
DECLARE
  -- JavaScript's String.prototype.trim() whitespace, so a purpose is blank
  -- exactly when App Admin's trim() says so.
  c_space CONSTANT text := E'\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
  v_purpose text;
  v_user_id uuid;
  v_client record;
  v_entry record;
BEGIN
  IF p_client_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'p_client_id and p_actor_id are required' USING ERRCODE = 'ORG01';
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') THEN
    RAISE EXCEPTION 'actor type must be human or agent' USING ERRCODE = 'ORG01';
  END IF;
  -- official_app_registry_purpose_valid, after trimming.
  v_purpose := NULLIF(pg_catalog.regexp_replace(p_purpose, '^[' || c_space || ']+|[' || c_space || ']+$', '', 'g'), '');
  IF v_purpose IS NULL OR pg_catalog.char_length(v_purpose) > 160 OR v_purpose ~ '[\r\n]' THEN
    RAISE EXCEPTION 'purpose must be one line of 1 to 160 characters' USING ERRCODE = 'ORG01';
  END IF;
  -- A person who is an owner or admin of Botiverse now, membership row
  -- locked until this transaction ends.
  v_user_id := public.official_app_registry_require_operator(p_actor_type, p_actor_id);

  SELECT c.id, c.client_id, c.server_id, c.app_type, c.publish_status
    INTO v_client
    FROM public.oauth_clients c
    WHERE c.id = p_client_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'App not found' USING ERRCODE = 'ORG02';
  END IF;
  -- An entry, in any status, is changed with official_app_registry_update.
  IF EXISTS (SELECT 1 FROM public.official_app_registry WHERE oauth_client_id = p_client_id) THEN
    RAISE EXCEPTION 'the App is already in the official registry' USING ERRCODE = 'ORG04';
  END IF;
  IF v_client.app_type = 'slock_builtin'
    OR EXISTS (SELECT 1 FROM public.external_app_registrations WHERE oauth_client_id = p_client_id) THEN
    RAISE EXCEPTION 'the App is platform-managed' USING ERRCODE = 'ORG03';
  END IF;
  IF v_client.app_type <> 'third_party_global' OR v_client.publish_status NOT IN ('published', 'unpublish_requested') THEN
    RAISE EXCEPTION 'only a published Marketplace App can be official'
      USING ERRCODE = 'ORG03', DETAIL = 'app type: ' || v_client.app_type || ', status: ' || v_client.publish_status;
  END IF;
  -- official_app_registry_client_key_valid
  IF v_client.client_id !~ '^[a-z][a-z0-9-]{2,63}$' THEN
    RAISE EXCEPTION 'the App''s client key does not fit the registry' USING ERRCODE = 'ORG03';
  END IF;

  INSERT INTO public.official_app_registry (
    oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision,
    created_by_user_id, updated_by_user_id
  ) VALUES (
    v_client.id, v_client.client_id, v_client.server_id, false, v_purpose, 'pending_review', 1,
    v_user_id, v_user_id
  )
  ON CONFLICT DO NOTHING
  RETURNING oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision
  INTO v_entry;
  -- A concurrent registration of the same App committed first.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the App is already in the official registry' USING ERRCODE = 'ORG04';
  END IF;

  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_entry.publisher_server_id, p_client_id,
    'official_app.registry_created', 'registration', 'success', 'api',
    p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id,
    pg_catalog.jsonb_build_object(
      'clientKey', v_entry.client_key,
      'publisherServerId', v_entry.publisher_server_id,
      'revision', v_entry.revision,
      'autoInstall', v_entry.auto_install,
      'status', v_entry.status,
      'purpose', v_entry.purpose
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'clientId', v_entry.oauth_client_id,
    'clientKey', v_entry.client_key,
    'publisherServerId', v_entry.publisher_server_id,
    'previousStatus', NULL::text,
    'status', v_entry.status,
    'revision', v_entry.revision,
    'autoInstall', v_entry.auto_install,
    'purpose', v_entry.purpose
  );
END
$official_app_registry_register$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.official_app_registry_update(
  p_client_id uuid,
  p_expected_revision integer,
  p_status text,
  p_purpose text,
  p_actor_type text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $official_app_registry_update$
DECLARE
  -- JavaScript's String.prototype.trim() whitespace, so a purpose is blank
  -- exactly when App Admin's trim() says so.
  c_space CONSTANT text := E'\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
  v_purpose text;
  v_user_id uuid;
  v_client record;
  v_entry record;
  v_after record;
  v_changed text[] := '{}';
  v_diff jsonb := '{}';
  v_removed boolean;
  v_metadata jsonb;
BEGIN
  IF p_client_id IS NULL OR p_actor_id IS NULL OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'p_client_id, p_expected_revision and p_actor_id are required' USING ERRCODE = 'ORG01';
  END IF;
  IF p_expected_revision < 1 THEN
    RAISE EXCEPTION 'expected revision must be positive' USING ERRCODE = 'ORG01';
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') THEN
    RAISE EXCEPTION 'actor type must be human or agent' USING ERRCODE = 'ORG01';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('approved', 'disabled') THEN
    RAISE EXCEPTION 'status must be approved or disabled' USING ERRCODE = 'ORG01';
  END IF;
  IF p_purpose IS NOT NULL THEN
    v_purpose := NULLIF(pg_catalog.regexp_replace(p_purpose, '^[' || c_space || ']+|[' || c_space || ']+$', '', 'g'), '');
    IF v_purpose IS NULL OR pg_catalog.char_length(v_purpose) > 160 OR v_purpose ~ '[\r\n]' THEN
      RAISE EXCEPTION 'purpose must be one line of 1 to 160 characters' USING ERRCODE = 'ORG01';
    END IF;
  ELSIF p_status IS NULL THEN
    RAISE EXCEPTION 'give a status, a purpose or both' USING ERRCODE = 'ORG01';
  END IF;
  -- A person who is an owner or admin of Botiverse now, membership row
  -- locked until this transaction ends.
  v_user_id := public.official_app_registry_require_operator(p_actor_type, p_actor_id);

  -- The App first, then its entry (the order register takes them in). The
  -- foreign key means an entry always has its App.
  SELECT c.id, c.client_id, c.app_type, c.publish_status
    INTO v_client
    FROM public.oauth_clients c
    WHERE c.id = p_client_id
    FOR SHARE;
  SELECT r.oauth_client_id, r.client_key, r.publisher_server_id, r.auto_install, r.purpose, r.status, r.revision
    INTO v_entry
    FROM public.official_app_registry r
    WHERE r.oauth_client_id = p_client_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the App is not in the official registry' USING ERRCODE = 'ORG02';
  END IF;
  IF v_entry.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'the entry changed since it was shown'
      USING ERRCODE = 'ORG05', DETAIL = 'revision: ' || v_entry.revision || ', status: ' || v_entry.status;
  END IF;
  IF p_status = v_entry.status THEN
    RAISE EXCEPTION 'the entry is already %', p_status USING ERRCODE = 'ORG06';
  END IF;
  IF v_purpose = v_entry.purpose THEN
    RAISE EXCEPTION 'the purpose is unchanged' USING ERRCODE = 'ORG06';
  END IF;

  -- Approving (or re-enabling) needs an App that can be official now, as
  -- registering did; disabling and editing the purpose do not.
  IF p_status = 'approved' THEN
    IF v_client.app_type = 'slock_builtin'
      OR EXISTS (SELECT 1 FROM public.external_app_registrations WHERE oauth_client_id = p_client_id) THEN
      RAISE EXCEPTION 'the App is platform-managed' USING ERRCODE = 'ORG03';
    END IF;
    IF v_client.app_type <> 'third_party_global' OR v_client.publish_status NOT IN ('published', 'unpublish_requested') THEN
      RAISE EXCEPTION 'only a published Marketplace App can be official'
        USING ERRCODE = 'ORG03', DETAIL = 'app type: ' || v_client.app_type || ', status: ' || v_client.publish_status;
    END IF;
  END IF;

  UPDATE public.official_app_registry SET
    auto_install = false,
    purpose = coalesce(v_purpose, purpose),
    status = coalesce(p_status, status),
    revision = revision + 1,
    updated_by_user_id = v_user_id,
    updated_at = pg_catalog.now()
  WHERE oauth_client_id = p_client_id
  RETURNING oauth_client_id, client_key, publisher_server_id, auto_install, purpose, status, revision
  INTO v_after;

  -- changedFields and diff in FFA's field order; integrationAuditService's
  -- diff allowlist takes these three.
  IF v_entry.auto_install THEN
    v_changed := v_changed || 'autoInstall'::text;
    v_diff := v_diff || pg_catalog.jsonb_build_object('autoInstall', pg_catalog.jsonb_build_object('before', true, 'after', false));
  END IF;
  IF v_after.purpose <> v_entry.purpose THEN
    v_changed := v_changed || 'purpose'::text;
    v_diff := v_diff || pg_catalog.jsonb_build_object('purpose', pg_catalog.jsonb_build_object('before', v_entry.purpose, 'after', v_after.purpose));
  END IF;
  IF v_after.status <> v_entry.status THEN
    v_changed := v_changed || 'status'::text;
    v_diff := v_diff || pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('before', v_entry.status, 'after', v_after.status));
  END IF;

  -- Disabling ends official-only capabilities: a revocation, as FFA records
  -- it. Everything else is an update and names its changed fields.
  v_removed := v_after.status = 'disabled';
  v_metadata := pg_catalog.jsonb_build_object(
    'clientKey', v_after.client_key,
    'publisherServerId', v_after.publisher_server_id,
    'revision', v_after.revision,
    'autoInstall', v_after.auto_install,
    'status', v_after.status,
    'purpose', v_after.purpose
  );
  IF NOT v_removed THEN
    v_metadata := v_metadata || pg_catalog.jsonb_build_object('changedFields', pg_catalog.to_jsonb(v_changed));
  END IF;
  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata, diff
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_after.publisher_server_id, p_client_id,
    CASE WHEN v_removed THEN 'official_app.registry_removed' ELSE 'official_app.registry_updated' END,
    CASE WHEN v_removed THEN 'revocation' ELSE 'registration' END,
    'success', 'api', p_actor_type, p_actor_id, 'app', p_client_id, 'app', p_client_id,
    v_metadata, v_diff
  );

  RETURN pg_catalog.jsonb_build_object(
    'clientId', v_after.oauth_client_id,
    'clientKey', v_after.client_key,
    'publisherServerId', v_after.publisher_server_id,
    'previousStatus', v_entry.status,
    'status', v_after.status,
    'revision', v_after.revision,
    'autoInstall', v_after.auto_install,
    'purpose', v_after.purpose
  );
END
$official_app_registry_update$;
