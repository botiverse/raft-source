-- The shared schema exists in every environment, but the production-only
-- Feature Flag Admin role does not. Install a durable reconciler now and invoke
-- it from the production-required post-migration guard. This prevents an absent
-- role from turning 0240 into a permanently journaled no-op: a later manual
-- GRANT still cannot close readiness until the migration-owned function runs
-- and writes its receipt.
CREATE TABLE IF NOT EXISTS public.feature_flag_admin_privilege_receipts (
  contract_key text PRIMARY KEY,
  migration_tag text NOT NULL,
  applied_at timestamptz NOT NULL,
  applied_by text NOT NULL
);

REVOKE ALL PRIVILEGES ON TABLE public.feature_flag_admin_privilege_receipts FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reconcile_feature_flag_admin_announcement_privileges()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $feature_flag_admin_announcement_privileges$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'feature_flag_admin_operator'
  ) THEN
    RAISE EXCEPTION 'feature_flag_admin_operator is required before privilege reconciliation'
      USING ERRCODE = '42704';
  END IF;

  -- Clear direct schema/table access and delegation rights before rebuilding
  -- the route's exact base matrix. Effective inherited rights are rejected by
  -- the authoritative readback that immediately follows this function.
  EXECUTE 'REVOKE ALL PRIVILEGES ON SCHEMA public FROM feature_flag_admin_operator';
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.announcement_audit_events FROM feature_flag_admin_operator';
  EXECUTE 'GRANT USAGE ON SCHEMA public TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.announcements TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE public.announcement_audit_events TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'announcement-lifecycle-v1',
    '0240_feature_flag_admin_announcement_privileges',
    clock_timestamp(),
    current_user
  )
  ON CONFLICT (contract_key) DO UPDATE SET
    migration_tag = EXCLUDED.migration_tag,
    applied_at = EXCLUDED.applied_at,
    applied_by = EXCLUDED.applied_by;
END
$feature_flag_admin_announcement_privileges$;

REVOKE ALL PRIVILEGES ON FUNCTION public.reconcile_feature_flag_admin_announcement_privileges() FROM PUBLIC;
