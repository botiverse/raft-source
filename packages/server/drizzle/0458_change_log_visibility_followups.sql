-- change_log visibility follow-ups (Tenny's approval of #11459, before clients
-- adopt GET /api/sync/changes):
-- 1. joint_channels.status leaving 'active' revokes the joint from its members
--    on every projection (access requires an active joint): scope_removed per
--    member and active projection, in that projection's server stream.
-- 2. Any server role change resets the person's stream in that server, not
--    only guest <-> member: an admin demoted to member loses viewMachines (and
--    other capabilities), and their client would otherwise keep those lists.
-- 3. A guest-readable public channel being archived logs channel_guest_lost
--    (guests cannot read archived channels; non-guests still see it as archived,
--    in its own scope). The guest feature flag (server_guest_v0) changing writes
--    one guest_access reset row; the read side applies it to guest viewers only
--    (who it affects is decided by rule evaluation, not by any one row).
-- 4. channel_public_lost / channel_guest_lost only when the channel was not
--    already deleted, so later updates of a deleted channel do not log again.
--
-- Locks: replaces the trigger functions of channels and server_members (their
-- triggers stay) and adds triggers on joint_channels and the feature flag
-- tables; deploy in the low period with the rest of change_log.
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_channels_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_channels_fn$
DECLARE r public.channels%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.change_log_add(r.server_id, 'channel', r.id, r.parent_channel_id, 'channel', r.id::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  IF TG_OP <> 'INSERT' AND OLD.type = 'channel' AND OLD.deleted_at IS NULL THEN
    -- Non-guest members saw every public channel; #all is hidden by turning it
    -- private, so the type change covers it.
    IF TG_OP = 'DELETE' OR NEW.type <> 'channel' OR NEW.deleted_at IS NOT NULL THEN
      PERFORM public.change_log_add(OLD.server_id, 'server', OLD.server_id, NULL, 'channel_public_lost', OLD.id::text, 'upsert');
    END IF;
    IF OLD.guest_visible AND OLD.archived_at IS NULL AND (TG_OP = 'DELETE' OR NOT NEW.guest_visible
        OR NEW.type <> 'channel' OR NEW.deleted_at IS NOT NULL OR NEW.archived_at IS NOT NULL) THEN
      PERFORM public.change_log_add(OLD.server_id, 'server', OLD.server_id, NULL, 'channel_guest_lost', OLD.id::text, 'upsert');
    END IF;
  END IF;
  RETURN NULL;
END
$change_log_channels_fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_server_members_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_server_members_fn$
DECLARE r public.server_members%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.change_log_add(r.server_id, 'server', r.server_id, NULL, 'server_member', r.user_id::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  IF TG_OP <> 'UPDATE' THEN
    PERFORM public.change_log_add(NULL, 'user', r.user_id, NULL, 'server', r.server_id::text,
      CASE WHEN TG_OP = 'DELETE' THEN 'scope_removed' ELSE 'scope_added' END);
  ELSIF OLD.role IS DISTINCT FROM NEW.role THEN
    PERFORM public.change_log_add(r.server_id, 'user', r.user_id, NULL, 'server', r.server_id::text, 'reset');
  END IF;
  RETURN NULL;
END
$change_log_server_members_fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_joint_channels_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_joint_channels_fn$
DECLARE m record;
BEGIN
  FOR m IN
    SELECT jm.user_id, s.server_id, s.local_channel_id
    FROM public.joint_channel_members jm
    JOIN public.joint_channel_servers s ON s.joint_channel_id = jm.joint_channel_id AND s.status = 'active'
    WHERE jm.joint_channel_id = OLD.id
  LOOP
    PERFORM public.change_log_add(m.server_id, 'user', m.user_id, NULL, 'channel', m.local_channel_id::text, 'scope_removed');
  END LOOP;
  RETURN NULL;
END
$change_log_joint_channels_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_joint_channels_inactive AFTER UPDATE OF status ON public.joint_channels
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.change_log_joint_channels_fn();--> statement-breakpoint
-- The guest feature flag: any change to its definition, its rules, or the
-- membership of an audience one of its audience rules names. One row; the read
-- side resets guest viewers of any server on it (scope_id = the nil uuid).
-- Covers the flag itself and its user / server / audience / percentage rules.
-- Rules that change with time or elsewhere (plan, lab: trial expiry, Labs
-- toggles) write nothing; server_guest_v0 has none (prod 10-27: one server-stage
-- allow rule). A plan or lab rule added to it needs its own reset path.
CREATE OR REPLACE FUNCTION public.change_log_guest_access_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_guest_access_fn$
DECLARE j jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN j := to_jsonb(OLD); ELSE j := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'feature_flags' AND (j ->> 'key') IS DISTINCT FROM 'server_guest_v0' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'feature_flag_rules' AND (j ->> 'flag_key') IS DISTINCT FROM 'server_guest_v0' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'feature_flag_audience_members' AND NOT EXISTS (
    SELECT 1 FROM public.feature_flag_rules fr
    WHERE fr.flag_key = 'server_guest_v0' AND fr.stage = 'audience' AND fr.values ? (j ->> 'audience_key')
  ) THEN
    RETURN NULL;
  END IF;
  PERFORM public.change_log_add(NULL, 'server', '00000000-0000-0000-0000-000000000000'::uuid, NULL, 'guest_access', 'server_guest_v0', 'reset');
  RETURN NULL;
END
$change_log_guest_access_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_guest_access_flags AFTER INSERT OR UPDATE OR DELETE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.change_log_guest_access_fn();--> statement-breakpoint
CREATE TRIGGER change_log_guest_access_rules AFTER INSERT OR UPDATE OR DELETE ON public.feature_flag_rules
  FOR EACH ROW EXECUTE FUNCTION public.change_log_guest_access_fn();--> statement-breakpoint
CREATE TRIGGER change_log_guest_access_audience_members AFTER INSERT OR DELETE ON public.feature_flag_audience_members
  FOR EACH ROW EXECUTE FUNCTION public.change_log_guest_access_fn();
