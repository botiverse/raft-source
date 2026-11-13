-- Review decisions need a person who is an owner or admin of Botiverse at the
-- moment of the write, for every review type, publish/offline included
-- (#proj-apps task #19; yezizp, artin). App Admin cannot check and then write
-- atomically, and its role is meant to end up with EXECUTE only, so the check
-- lives here, in the write's own statement, in gated entry functions:
--
--   app_admin_decide_publish_review          gate, then marketplace_decide_publish_review
--   app_admin_decide_action_endpoint_review  gate, then marketplace_decide_action_endpoint_review
--
-- The entries are what App Admin's role may execute. The decision bodies stay
-- owner-only: marketplace_decide_publish_review is unchanged (it only loses
-- App Admin's grant, below), and the card URL body is new. The Raft server
-- keeps calling the bodies, as the owner, behind its own reviewer list
-- (SLOCK_MARKETPLACE_REVIEWER_USER_IDS), until its review routes are retired.
--
-- Errors use 0476's SQLSTATE class with the same meanings, adding:
--   RVW07 entry only: the actor is not a person who is a Botiverse owner or
--         admin now
--
-- The gate: who may decide reviews. The shape of
-- official_app_registry_require_operator, with this class's codes:
--
-- - an invalid actor type or no actor id: RVW01;
-- - an agent: RVW07, whatever its role in Botiverse;
-- - an unknown or retired user: RVW01;
-- - a person needs a server_members row in Botiverse
--   (95f993fa-2a68-4797-b8ae-7beb7d984ada, the platform's own Server; App
--   Admin pins the same id) with role owner or admin, on a Server that is not
--   deleted. The row is taken FOR SHARE before any App row, so a concurrent
--   demotion or removal waits for this decision, and a decision that starts
--   after it sees the new role. No such row: RVW07.
--
-- Invoker rights, executable by its owner only: it runs as the owner inside
-- the definer-rights entries, and App Admin's role cannot call it.
CREATE FUNCTION public.marketplace_review_require_decider(
  p_actor_type text,
  p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $marketplace_review_require_decider$
DECLARE
  -- Botiverse, the platform's own Server.
  c_platform_server_id CONSTANT uuid := '95f993fa-2a68-4797-b8ae-7beb7d984ada';
BEGIN
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'agent') OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'actor type must be human or agent, with an actor id' USING ERRCODE = 'RVW01';
  END IF;
  IF p_actor_type = 'agent' THEN
    RAISE EXCEPTION 'review decisions are made by a person' USING ERRCODE = 'RVW07';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'unknown actor' USING ERRCODE = 'RVW01';
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
    RAISE EXCEPTION 'review decisions need a Botiverse owner or admin' USING ERRCODE = 'RVW07';
  END IF;
  RETURN p_actor_id;
END
$marketplace_review_require_decider$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_review_require_decider(text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- Card URL (action endpoint) review: what the server's
-- reviewPendingActionEndpoint did in TypeScript until now (RFC 076 §4). For
-- one App's link-preview registration, nothing else:
--
--   approve  the pending endpoint goes in force; pending, its request time and
--            the last reject reason are cleared; a new revision voids every
--            outstanding card handle
--   reject   pending and its request time are cleared and the trimmed reason
--            is kept for the developer; what is in force and the revision stay
--
-- plus one app.action_endpoint_reviewed audit event (actor the human
-- reviewer, category registration, metadata clientKey and decision, as
-- integrationAuditService writes it). No socket event, outbox row or cache
-- follows the server's decision, and the table has no trigger, so a call from
-- App Admin's entry is the whole decision too.
--
-- Who may review stays with the caller (the server's reviewer list, or the
-- gated entry below). Invoker rights and executable by its owner only, like
-- the gate: the server calls it as the owner, and the entry runs it as the
-- owner. search_path pg_catalog, then pg_temp; every relation
-- schema-qualified; no dynamic SQL.
--
-- Errors:
--   RVW01 invalid argument: no App or reviewer id; decision not approve or
--         reject; expected endpoint blank or over 2000 characters; a reason
--         with approve; a reject reason blank after trimming or over 2000
--         characters; unknown or retired reviewer
--   RVW02 no such App
--   RVW04 no action endpoint is waiting for review
--   RVW05 the pending endpoint is not the one the reviewer was shown; DETAIL
--         is JSON {"pending": <the pending endpoint now>}
CREATE FUNCTION public.marketplace_decide_action_endpoint_review(
  p_client_id uuid,
  p_decision text,
  p_expected_action_endpoint text,
  p_reviewer_user_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $marketplace_decide_action_endpoint_review$
DECLARE
  -- JavaScript's String.prototype.trim() whitespace, so a value counts as
  -- blank exactly when the server's trim() said so.
  c_space CONSTANT text := E'\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
  v_now timestamptz := pg_catalog.now();
  v_approve boolean;
  v_reason text;
  v_link record;
  v_action_endpoint text;
  v_revision uuid;
BEGIN
  -- ── Arguments ──────────────────────────────────────────────────────────
  IF p_client_id IS NULL OR p_reviewer_user_id IS NULL THEN
    RAISE EXCEPTION 'p_client_id and p_reviewer_user_id are required' USING ERRCODE = 'RVW01';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'RVW01';
  END IF;
  IF NOT coalesce(p_expected_action_endpoint ~ ('[^' || c_space || ']'), false)
    OR pg_catalog.char_length(p_expected_action_endpoint) > 2000 THEN
    RAISE EXCEPTION 'expected action endpoint must be the pending endpoint shown, at most 2000 characters' USING ERRCODE = 'RVW01';
  END IF;
  v_approve := p_decision = 'approve';
  IF v_approve AND p_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a reason is recorded only with reject' USING ERRCODE = 'RVW01';
  END IF;
  IF NOT v_approve THEN
    v_reason := NULLIF(pg_catalog.regexp_replace(p_reason, '^[' || c_space || ']+|[' || c_space || ']+$', '', 'g'), '');
    IF v_reason IS NULL OR pg_catalog.char_length(v_reason) > 2000 THEN
      RAISE EXCEPTION 'a rejection needs a reason of 1 to 2000 characters' USING ERRCODE = 'RVW01';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_reviewer_user_id AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'unknown reviewer' USING ERRCODE = 'RVW01';
  END IF;

  -- ── The registration, locked, with what the reviewer was shown ─────────
  -- The link-preview row only, as the server locked it.
  SELECT p.action_endpoint, p.pending_action_endpoint, p.revision, c.server_id, c.client_id AS client_key
    INTO v_link
    FROM public.oauth_app_link_previews p
    JOIN public.oauth_clients c ON c.id = p.client_id
    WHERE p.client_id = p_client_id
    FOR UPDATE OF p;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.oauth_clients WHERE id = p_client_id) THEN
      RAISE EXCEPTION 'App not found' USING ERRCODE = 'RVW02';
    END IF;
    RAISE EXCEPTION 'no action endpoint is waiting for review' USING ERRCODE = 'RVW04';
  END IF;
  -- An empty string counts as nothing waiting, as the server's check did.
  IF v_link.pending_action_endpoint IS NULL OR v_link.pending_action_endpoint = '' THEN
    RAISE EXCEPTION 'no action endpoint is waiting for review' USING ERRCODE = 'RVW04';
  END IF;
  IF v_link.pending_action_endpoint <> p_expected_action_endpoint THEN
    RAISE EXCEPTION 'the pending action endpoint changed since it was shown'
      USING ERRCODE = 'RVW05',
            DETAIL = pg_catalog.jsonb_build_object('pending', v_link.pending_action_endpoint)::text;
  END IF;

  IF v_approve THEN
    v_action_endpoint := v_link.pending_action_endpoint;
    v_revision := pg_catalog.gen_random_uuid();
    UPDATE public.oauth_app_link_previews SET
      action_endpoint = v_action_endpoint,
      pending_action_endpoint = NULL,
      pending_action_endpoint_requested_at = NULL,
      action_endpoint_reject_reason = NULL,
      revision = v_revision,
      updated_at = v_now
    WHERE client_id = p_client_id;
  ELSE
    v_action_endpoint := v_link.action_endpoint;
    v_revision := v_link.revision;
    UPDATE public.oauth_app_link_previews SET
      pending_action_endpoint = NULL,
      pending_action_endpoint_requested_at = NULL,
      action_endpoint_reject_reason = v_reason,
      updated_at = v_now
    WHERE client_id = p_client_id;
  END IF;

  INSERT INTO public.integration_audit_events (
    id, server_id, client_id, event_type, event_category, outcome, source,
    actor_type, actor_id, subject_type, subject_id, target_type, target_id, metadata
  ) VALUES (
    pg_catalog.gen_random_uuid(), v_link.server_id, p_client_id, 'app.action_endpoint_reviewed', 'registration', 'success', 'api',
    'human', p_reviewer_user_id, 'app', p_client_id, 'app', p_client_id,
    pg_catalog.jsonb_build_object('clientKey', v_link.client_key, 'decision', p_decision)
  );

  RETURN pg_catalog.jsonb_build_object(
    'clientId', p_client_id,
    'decision', p_decision,
    'actionEndpoint', v_action_endpoint,
    'revision', v_revision
  );
END
$marketplace_decide_action_endpoint_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_decide_action_endpoint_review(uuid, text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- The entries App Admin calls: the gate (membership row locked until the
-- transaction ends), then the body, in that order, so the membership row is
-- always locked before the App's. SECURITY DEFINER, so a caller needs EXECUTE
-- only; the gate and the body run as the owner. search_path pg_catalog, then
-- pg_temp, and the functions they call are schema-qualified.
--
-- The publish entry takes marketplace_decide_publish_review's arguments and
-- returns its result or its refusal unchanged; the agent actor type stays a
-- valid argument there and is refused by the gate.
CREATE FUNCTION public.app_admin_decide_publish_review(
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
AS $app_admin_decide_publish_review$
BEGIN
  PERFORM public.marketplace_review_require_decider(p_actor_type, p_actor_id);
  RETURN public.marketplace_decide_publish_review(p_client_id, p_decision, p_expected_status, p_actor_type, p_actor_id, p_reason);
END
$app_admin_decide_publish_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.app_admin_decide_action_endpoint_review(
  p_client_id uuid,
  p_decision text,
  p_expected_action_endpoint text,
  p_actor_type text,
  p_actor_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $app_admin_decide_action_endpoint_review$
BEGIN
  PERFORM public.marketplace_review_require_decider(p_actor_type, p_actor_id);
  RETURN public.marketplace_decide_action_endpoint_review(p_client_id, p_decision, p_expected_action_endpoint, p_actor_id, p_reason);
END
$app_admin_decide_action_endpoint_review$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- Redefined in full, as each App Admin contract migration does: App Admin's
-- role may use schema public and execute the two review entries and the two
-- registry functions, nothing else. It loses EXECUTE on
-- marketplace_decide_publish_review, which it held since that function was
-- added: a decision now goes through the gate. The bodies and the gate are
-- revoked by name too, so a stray grant cannot survive a deploy. Until the
-- role exists this returns false and writes nothing; the server deploy runs
-- it after migrations (scripts/verify-app-admin-privileges.ts) and reads back
-- the receipt and the role's effective privileges.
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
  REVOKE ALL PRIVILEGES ON FUNCTION public.marketplace_review_require_decider(text, uuid) FROM app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_decide_publish_review(uuid, text, text, text, uuid, text) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.app_admin_decide_action_endpoint_review(uuid, text, text, text, uuid, text) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.official_app_registry_register(uuid, text, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.official_app_registry_register(uuid, text, text, uuid) TO app_admin_operator;
  REVOKE ALL PRIVILEGES ON FUNCTION public.official_app_registry_update(uuid, integer, text, text, text, uuid) FROM app_admin_operator;
  GRANT EXECUTE ON FUNCTION public.official_app_registry_update(uuid, integer, text, text, text, uuid) TO app_admin_operator;

  INSERT INTO public.app_admin_privilege_receipts (contract_key, migration_tag, applied_at, applied_by)
  VALUES ('app-admin-functions-v3', '0562_marketplace_review_decider_gate', pg_catalog.clock_timestamp(), current_user)
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
  RETURN true;
END
$reconcile_app_admin_privileges$;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_app_admin_privileges() FROM PUBLIC;
