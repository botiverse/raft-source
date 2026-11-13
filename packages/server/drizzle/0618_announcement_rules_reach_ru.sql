-- announcement_rules_reach (0617) hard-coded the display-locale list without
-- 'ru' (#13083 landed the same day), so a Russian user counted as "locale
-- unknown" and a `locale = ru` condition never matched in the FFA preview.
-- Same signature, so CREATE OR REPLACE keeps the owner, SECURITY DEFINER and
-- the existing EXECUTE grant; the reconciler and its receipt are unchanged.
-- The list must equal DISPLAY_LOCALES (packages/shared); a test enforces it.
CREATE OR REPLACE FUNCTION public.announcement_rules_reach(
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
           CASE WHEN u.display_language IN ('en', 'es', 'pt-br', 'ru', 'ko', 'ja', 'zh-cn', 'zh-tw') THEN u.display_language END AS locale,
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
           CASE WHEN u.display_language IN ('en', 'es', 'pt-br', 'ru', 'ko', 'ja', 'zh-cn', 'zh-tw') THEN u.display_language END,
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
