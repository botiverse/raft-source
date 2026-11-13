-- How many accounts an announcement's audience rules (#12705, audience.rules)
-- would reach, for Feature Flag Admin's reach preview (task #31; Gogo
-- 4f60efe8: a count-only SECURITY DEFINER function, EXECUTE to the FFA role,
-- no new column grants). Returns one integer and never a row, an ID or a fact
-- about one account. Counts below 5 come back as NULL ("fewer than 5"), so a
-- one-account scope cannot be used to probe that account's created_at,
-- language, role or plan condition by condition; listed scopes (users,
-- server_users) under 20 accounts also come back NULL. Callers set their own
-- statement_timeout (a function-level SET does not bound the running query).
--
-- Semantics mirror matchesAnnouncementRules (packages/shared/announcement-audience.ts):
-- a condition whose fact is unknown never matches, negated or not. The
-- request-time server is not known here, so a candidate is one account with
-- one of its live non-Guest memberships; account-wide scopes also count the
-- account with no Server open. An account counts once if any candidate
-- matches: an upper bound, as a user matches only in the Server they have
-- open. feature_flag and platform are per request and counted as matching
-- (also an upper bound); FFA says so in the preview's basis.
--
-- p_scope mirrors audience.type:
--   all             every account (Guest-only accounts excluded, as delivery)
--   users           p_user_ids, account-wide
--   server_members  members of p_server_ids, in that Server
--   server_users    (p_server_ids[i], p_user_ids[i]) pairs, in that Server
--
-- SECURITY DEFINER, search_path pg_catalog then pg_temp, every relation
-- schema-qualified, no dynamic SQL. Read-only (STABLE).
CREATE FUNCTION public.announcement_rules_reach(
  p_rules jsonb,
  p_scope text,
  p_user_ids uuid[],
  p_server_ids uuid[],
  p_now timestamptz
) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $announcement_rules_reach$
DECLARE
  v_count integer;
  v_scope integer;
BEGIN
  IF p_rules IS NULL OR pg_catalog.jsonb_typeof(p_rules) <> 'object'
    OR pg_catalog.jsonb_typeof(p_rules -> 'groups') <> 'array'
    OR (p_rules ->> 'match') NOT IN ('all', 'any') THEN
    RAISE EXCEPTION 'p_rules must be validated audience rules' USING ERRCODE = '22023';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'users', 'server_members', 'server_users') THEN
    RAISE EXCEPTION 'unknown scope' USING ERRCODE = '22023';
  END IF;
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'p_now is required' USING ERRCODE = '22023';
  END IF;

  WITH candidate AS (
    -- The account with no Server open (account-wide scopes only).
    -- A language outside DISPLAY_LOCALES is unknown, as the server's rule context reads it.
    SELECT u.id AS user_id, u.created_at AS account_created,
           CASE WHEN u.display_language IN ('en', 'es', 'pt-br', 'ko', 'ja', 'zh-cn', 'zh-tw') THEN u.display_language END AS locale,
           NULL::timestamptz AS server_created, NULL::text AS server_plan, NULL::text AS server_role
    FROM public.users AS u
    WHERE p_scope IN ('all', 'users')
      AND (p_scope = 'all' OR u.id = ANY (p_user_ids))
      AND NOT (EXISTS (
        SELECT 1 FROM public.server_members AS gm JOIN public.servers AS gs ON gs.id = gm.server_id
        WHERE gm.user_id = u.id AND gm.role = 'guest' AND gs.deleted_at IS NULL AND gs.kind <> 'joint_storage'
      ) AND NOT EXISTS (
        SELECT 1 FROM public.server_members AS nm JOIN public.servers AS ns ON ns.id = nm.server_id
        WHERE nm.user_id = u.id AND nm.role <> 'guest' AND ns.deleted_at IS NULL AND ns.kind <> 'joint_storage'
      ))
    UNION ALL
    -- The account in one of its live non-Guest memberships.
    SELECT u.id, u.created_at,
           CASE WHEN u.display_language IN ('en', 'es', 'pt-br', 'ko', 'ja', 'zh-cn', 'zh-tw') THEN u.display_language END,
           s.created_at, s.plan::text, m.role::text
    FROM public.server_members AS m
    JOIN public.users AS u ON u.id = m.user_id
    JOIN public.servers AS s ON s.id = m.server_id
    WHERE m.role <> 'guest' AND s.deleted_at IS NULL AND s.kind <> 'joint_storage'
      AND (
        p_scope = 'all'
        OR (p_scope = 'users' AND u.id = ANY (p_user_ids))
        OR (p_scope = 'server_members' AND s.id = ANY (p_server_ids))
        OR (p_scope = 'server_users' AND EXISTS (
          -- Multi-argument unnest is FROM-clause syntax and cannot be schema-qualified;
          -- search_path is pg_catalog first.
          SELECT 1 FROM unnest(p_server_ids, p_user_ids) AS wanted(server_id, user_id)
          WHERE wanted.server_id = s.id AND wanted.user_id = u.id
        ))
      )
  ), numbered AS (
    SELECT pg_catalog.row_number() OVER () AS candidate_id, candidate.* FROM candidate
  ), condition AS (
    SELECT g.ordinality AS group_index, g.value ->> 'match' AS group_match, c.value AS item
    FROM pg_catalog.jsonb_array_elements(p_rules -> 'groups') WITH ORDINALITY AS g(value, ordinality)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(g.value -> 'conditions') AS c(value)
  ), fact AS (
    -- holds is NULL when this candidate does not know the fact.
    SELECT n.candidate_id, n.user_id, k.group_index, k.group_match,
      k.item ->> 'field' AS field,
      COALESCE((k.item ->> 'negate')::boolean, false) AS negate,
      CASE k.item ->> 'field'
        WHEN 'account_created' THEN
          CASE k.item ->> 'op'
            WHEN 'within_days' THEN p_now - n.account_created <= pg_catalog.make_interval(days => (k.item ->> 'days')::integer)
            WHEN 'older_than_days' THEN p_now - n.account_created > pg_catalog.make_interval(days => (k.item ->> 'days')::integer)
            WHEN 'after' THEN n.account_created >= ((k.item ->> 'date') || 'T00:00:00Z')::timestamptz
            WHEN 'before' THEN n.account_created < ((k.item ->> 'date') || 'T00:00:00Z')::timestamptz
          END
        WHEN 'server_created' THEN
          CASE k.item ->> 'op'
            WHEN 'within_days' THEN p_now - n.server_created <= pg_catalog.make_interval(days => (k.item ->> 'days')::integer)
            WHEN 'older_than_days' THEN p_now - n.server_created > pg_catalog.make_interval(days => (k.item ->> 'days')::integer)
            WHEN 'after' THEN n.server_created >= ((k.item ->> 'date') || 'T00:00:00Z')::timestamptz
            WHEN 'before' THEN n.server_created < ((k.item ->> 'date') || 'T00:00:00Z')::timestamptz
          END
        WHEN 'server_role' THEN n.server_role = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text(k.item -> 'values')))
        WHEN 'server_plan' THEN n.server_plan = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text(k.item -> 'values')))
        WHEN 'locale' THEN n.locale = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text(k.item -> 'values')))
      END AS holds
    FROM numbered AS n CROSS JOIN condition AS k
  ), evaluated AS (
    SELECT candidate_id, user_id, group_index, group_match,
      CASE
        WHEN field IN ('feature_flag', 'platform') THEN true
        WHEN holds IS NULL THEN false
        ELSE holds <> negate
      END AS ok
    FROM fact
  ), grouped AS (
    SELECT candidate_id, user_id, group_index,
      CASE pg_catalog.min(group_match) WHEN 'all' THEN pg_catalog.bool_and(ok) ELSE pg_catalog.bool_or(ok) END AS ok
    FROM evaluated GROUP BY candidate_id, user_id, group_index
  ), matched AS (
    SELECT user_id
    FROM grouped GROUP BY candidate_id, user_id
    HAVING CASE p_rules ->> 'match' WHEN 'all' THEN pg_catalog.bool_and(ok) ELSE pg_catalog.bool_or(ok) END
  )
  SELECT
    (SELECT pg_catalog.count(DISTINCT user_id)::integer FROM matched),
    (SELECT pg_catalog.count(DISTINCT user_id)::integer FROM numbered)
  INTO v_count, v_scope;

  -- A short explicit list lets an operator difference one account against known
  -- ones (Gogo e58abe4c), so listed scopes need at least 20 resolvable accounts.
  IF p_scope IN ('users', 'server_users') AND v_scope < 20 THEN
    RETURN NULL;
  END IF;

  RETURN CASE WHEN v_count < 5 THEN NULL ELSE v_count END;
END
$announcement_rules_reach$;

REVOKE ALL PRIVILEGES ON FUNCTION public.announcement_rules_reach(jsonb, text, uuid[], uuid[], timestamptz) FROM PUBLIC;

--> statement-breakpoint
-- The reconciler, redefined in full as every FFA privilege migration does;
-- the only change from 0387 is EXECUTE on announcement_rules_reach and the
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

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0617_announcement_rules_reach',
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
