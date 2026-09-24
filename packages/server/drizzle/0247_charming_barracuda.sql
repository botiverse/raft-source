CREATE TABLE "feature_flag_audience_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"audience_key" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flag_audience_members_kind_valid" CHECK ("feature_flag_audience_members"."kind" IN ('user', 'server'))
);
--> statement-breakpoint
CREATE TABLE "feature_flag_audiences" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_flag_rules" DROP CONSTRAINT "feature_flag_rules_stage_valid";--> statement-breakpoint
ALTER TABLE "feature_flag_audience_members" ADD CONSTRAINT "feature_flag_audience_members_audience_key_feature_flag_audiences_key_fk" FOREIGN KEY ("audience_key") REFERENCES "public"."feature_flag_audiences"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feature_flag_audience_members_target" ON "feature_flag_audience_members" USING btree ("audience_key","kind","target_id");--> statement-breakpoint
CREATE INDEX "idx_feature_flag_audience_members_lookup" ON "feature_flag_audience_members" USING btree ("kind","target_id","audience_key");--> statement-breakpoint
ALTER TABLE "feature_flag_rules" ADD CONSTRAINT "feature_flag_rules_audience_shape_valid" CHECK ("feature_flag_rules"."stage" <> 'audience' OR ("feature_flag_rules"."percentage_basis_points" IS NULL AND "feature_flag_rules"."variant" IS NULL AND jsonb_array_length("feature_flag_rules"."values") > 0));--> statement-breakpoint
ALTER TABLE "feature_flag_rules" ADD CONSTRAINT "feature_flag_rules_stage_valid" CHECK ("feature_flag_rules"."stage" IN ('user', 'platform', 'server', 'audience', 'lab', 'plan', 'percentage'));
--> statement-breakpoint
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
  EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.announcements, public.announcement_audit_events, public.feature_flag_audiences, public.feature_flag_audience_members, public.users, public.servers FROM feature_flag_admin_operator';
  FOR projection IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (
      'announcements',
      'announcement_audit_events',
      'feature_flag_audiences',
      'feature_flag_audience_members',
      'users',
      'servers'
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
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.feature_flag_audiences TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT, INSERT, DELETE ON TABLE public.feature_flag_audience_members TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id) ON TABLE public.users TO feature_flag_admin_operator';
  EXECUTE 'GRANT SELECT (id, slug, deleted_at) ON TABLE public.servers TO feature_flag_admin_operator';

  INSERT INTO public.feature_flag_admin_privilege_receipts (
    contract_key,
    migration_tag,
    applied_at,
    applied_by
  ) VALUES (
    'operator-surfaces-v2',
    '0247_charming_barracuda',
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
