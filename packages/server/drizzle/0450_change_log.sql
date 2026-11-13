-- Incremental client sync: change_log (design: #triage:458d78f1, 10-23 report
-- "sync-change-feed", Tenny's event inventory 2026-10-27).
--
-- One row per change, keyed by who may see it (its scope), written by triggers
-- in the same transaction as the change itself, so no writer can forget it and
-- a rolled-back write leaves no row. GET /api/sync/changes reads it: rows after
-- the client's cursor, filtered to the viewer's scopes, then each changed
-- entity rebuilt from its current state for that viewer. The log records only
-- WHICH entity changed, never its content: the row shape stays owned by the
-- list endpoints, and per-viewer projections (emails, guest views) are applied
-- at read time.
--
-- Scope:
--   channel  scope_id = the channel; parent_id = a thread/task conversation's
--            parent channel (visibility inherits from it). server_id is
--            informational: a joint channel is visible from every projecting
--            server, so readers filter channel rows by visibility only.
--   server   scope_id = the server; every member of that server.
--   user     scope_id = the person; that person only. server_id = the server
--            stream it belongs to, NULL = every one of the person's streams
--            (server membership itself).
--
-- Commit order: seq is allocated at INSERT but transactions commit in another
-- order, so xid (the writing transaction) lets readers apply the same
-- pg_snapshot_xmin horizon as messages.insert_xid (0430 / syncHorizon.ts).
--
-- Retention: daily range partitions on created_at (UTC days), dropped after
-- 8 days (7 days served + 1 margin) by change_log_maintain(), which also
-- creates partitions ahead. change_log_default only catches rows if
-- maintenance stops for longer than its lead time; it must stay empty.
--
-- Not in schema.ts, like messages.insert_xid: drizzle cannot express a
-- partitioned table, and `drizzle-kit push` would drop it. Only the triggers
-- and the sync read path touch it.
--
-- Skip switch: a maintenance transaction that must not log (bulk backfill)
-- runs SET LOCAL slock.change_log_skip = 'on'. SET LOCAL ends with the
-- transaction, so the switch cannot stay on; a session-level SET is a bug.
-- Clients that missed those writes are told to resnapshot with
-- change_log_force_reset(server_id).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE SEQUENCE public.change_log_seq_seq AS bigint;--> statement-breakpoint
CREATE TABLE public.change_log (
  seq bigint NOT NULL DEFAULT nextval('public.change_log_seq_seq'),
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  server_id uuid,
  scope_kind text NOT NULL,
  scope_id uuid NOT NULL,
  parent_id uuid,
  entity text NOT NULL,
  entity_id text NOT NULL,
  op text NOT NULL,
  ref_seq bigint,
  CONSTRAINT change_log_scope_kind_check CHECK (scope_kind IN ('channel', 'server', 'user')),
  CONSTRAINT change_log_op_check CHECK (op IN ('upsert', 'delete', 'scope_added', 'scope_removed', 'reset'))
) PARTITION BY RANGE (created_at);--> statement-breakpoint
CREATE INDEX change_log_seq_idx ON public.change_log (seq);--> statement-breakpoint
CREATE INDEX change_log_scope_seq_idx ON public.change_log (scope_kind, scope_id, seq);--> statement-breakpoint
CREATE INDEX change_log_parent_seq_idx ON public.change_log (parent_id, seq) WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE public.change_log_default PARTITION OF public.change_log DEFAULT;--> statement-breakpoint
-- Creates the daily partitions from yesterday through ahead_days, drops those
-- that ended more than keep_days ago. Idempotent. Each DDL takes a short lock on
-- change_log; under contention it gives up (lock_timeout) and the next run
-- retries, rather than queueing writers behind it. A day whose rows already
-- sit in change_log_default is skipped (and reported): attaching it would fail.
CREATE OR REPLACE FUNCTION public.change_log_maintain(ahead_days integer DEFAULT 14, keep_days integer DEFAULT 8)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_maintain$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  part text;
  child record;
  child_day date;
BEGIN
  FOR d IN SELECT generate_series(today - 1, today + ahead_days, interval '1 day')::date LOOP
    part := 'change_log_p' || to_char(d, 'YYYYMMDD');
    CONTINUE WHEN to_regclass('public.' || part) IS NOT NULL;
    IF EXISTS (
      SELECT 1 FROM public.change_log_default
      WHERE created_at >= (d::timestamp AT TIME ZONE 'UTC') AND created_at < ((d + 1)::timestamp AT TIME ZONE 'UTC')
    ) THEN
      action := 'skipped_default_has_rows'; partition_name := part; RETURN NEXT;
      CONTINUE;
    END IF;
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.change_log FOR VALUES FROM (%L) TO (%L)',
      part, (d::timestamp AT TIME ZONE 'UTC'), ((d + 1)::timestamp AT TIME ZONE 'UTC'));
    action := 'created'; partition_name := part; RETURN NEXT;
  END LOOP;
  FOR child IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.change_log'::regclass AND c.relname ~ '^change_log_p[0-9]{8}$'
  LOOP
    child_day := to_date(substr(child.relname, 13), 'YYYYMMDD');
    IF child_day + 1 <= today - keep_days THEN
      EXECUTE format('DROP TABLE public.%I', child.relname);
      action := 'dropped'; partition_name := child.relname; RETURN NEXT;
    END IF;
  END LOOP;
END
$change_log_maintain$;--> statement-breakpoint
SELECT count(*) FROM public.change_log_maintain();--> statement-breakpoint
-- The single writer every trigger goes through.
CREATE OR REPLACE FUNCTION public.change_log_add(
  p_server_id uuid, p_scope_kind text, p_scope_id uuid, p_parent_id uuid,
  p_entity text, p_entity_id text, p_op text, p_ref_seq bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_add$
BEGIN
  IF p_scope_id IS NULL OR current_setting('slock.change_log_skip', true) = 'on' THEN
    RETURN;
  END IF;
  INSERT INTO public.change_log (server_id, scope_kind, scope_id, parent_id, entity, entity_id, op, ref_seq)
  VALUES (p_server_id, p_scope_kind, p_scope_id, p_parent_id, p_entity, p_entity_id, p_op, p_ref_seq);
END
$change_log_add$;--> statement-breakpoint
-- After a write made under the skip switch: every client of the server
-- resnapshots on its next read.
CREATE OR REPLACE FUNCTION public.change_log_force_reset(p_server_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_force_reset$
  INSERT INTO public.change_log (server_id, scope_kind, scope_id, entity, entity_id, op)
  VALUES (p_server_id, 'server', p_server_id, 'server', p_server_id::text, 'reset');
$change_log_force_reset$;--> statement-breakpoint
-- channels: the channel row (sidebar, name, archive, delete, visibility).
-- task_number_high_water moves on every task create and changes nothing shown.
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
  RETURN NULL;
END
$change_log_channels_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_channels_ins_del AFTER INSERT OR DELETE ON public.channels
  FOR EACH ROW EXECUTE FUNCTION public.change_log_channels_fn();--> statement-breakpoint
CREATE TRIGGER change_log_channels_upd AFTER UPDATE ON public.channels
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.guest_visible IS DISTINCT FROM NEW.guest_visible
    OR OLD.guest_joinable IS DISTINCT FROM NEW.guest_joinable OR OLD.parent_channel_id IS DISTINCT FROM NEW.parent_channel_id
    OR OLD.parent_message_id IS DISTINCT FROM NEW.parent_message_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id)
  EXECUTE FUNCTION public.change_log_channels_fn();--> statement-breakpoint
-- channel_humans / channel_agents: the member row in the channel's scope; for a
-- person, also the grant/revoke of that channel in their own scope (a new
-- scope means "snapshot this channel", a lost one means "drop it locally").
-- On a channel's cascade delete the channel row is already gone; the
-- channel's own delete row covers it, and the revoke still reaches the person.
CREATE OR REPLACE FUNCTION public.change_log_channel_members_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_channel_members_fn$
DECLARE
  v_channel uuid;
  v_member uuid;
  v_kind text;
  v_server uuid;
  v_parent uuid;
BEGIN
  v_kind := CASE WHEN TG_TABLE_NAME = 'channel_humans' THEN 'user' ELSE 'agent' END;
  IF TG_OP = 'DELETE' THEN
    v_channel := OLD.channel_id;
    v_member := CASE WHEN v_kind = 'user' THEN (to_jsonb(OLD) ->> 'user_id')::uuid ELSE (to_jsonb(OLD) ->> 'agent_id')::uuid END;
  ELSE
    v_channel := NEW.channel_id;
    v_member := CASE WHEN v_kind = 'user' THEN (to_jsonb(NEW) ->> 'user_id')::uuid ELSE (to_jsonb(NEW) ->> 'agent_id')::uuid END;
  END IF;
  SELECT c.server_id, c.parent_channel_id INTO v_server, v_parent FROM public.channels c WHERE c.id = v_channel;
  PERFORM public.change_log_add(v_server, 'channel', v_channel, v_parent, 'channel_member',
    v_channel::text || ':' || v_kind || ':' || v_member::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  IF v_kind = 'user' AND TG_OP <> 'UPDATE' THEN
    PERFORM public.change_log_add(v_server, 'user', v_member, NULL, 'channel', v_channel::text,
      CASE WHEN TG_OP = 'DELETE' THEN 'scope_removed' ELSE 'scope_added' END);
  END IF;
  RETURN NULL;
END
$change_log_channel_members_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_channel_humans_ins_del AFTER INSERT OR DELETE ON public.channel_humans
  FOR EACH ROW EXECUTE FUNCTION public.change_log_channel_members_fn();--> statement-breakpoint
CREATE TRIGGER change_log_channel_humans_upd AFTER UPDATE ON public.channel_humans
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.change_log_channel_members_fn();--> statement-breakpoint
CREATE TRIGGER change_log_channel_agents_ins_del AFTER INSERT OR DELETE ON public.channel_agents
  FOR EACH ROW EXECUTE FUNCTION public.change_log_channel_members_fn();--> statement-breakpoint
CREATE TRIGGER change_log_channel_agents_upd AFTER UPDATE ON public.channel_agents
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.change_log_channel_members_fn();--> statement-breakpoint
-- server_members (membership and role only; the per-user columns are batch 2):
-- the member row for the server, and the server grant/revoke for the person,
-- in every one of their streams (server_id NULL).
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
  END IF;
  RETURN NULL;
END
$change_log_server_members_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_server_members_ins_del AFTER INSERT OR DELETE ON public.server_members
  FOR EACH ROW EXECUTE FUNCTION public.change_log_server_members_fn();--> statement-breakpoint
CREATE TRIGGER change_log_server_members_upd AFTER UPDATE ON public.server_members
  FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.change_log_server_members_fn();--> statement-breakpoint
-- agents: directory columns only. status, session_id, runtime errors and
-- updated_at move with presence and the runtime, which travel on the presence
-- subscription; logging them would be most of the table's 215k updates a day.
-- server_agent_members (an agent's server role) changes the same agent row.
CREATE OR REPLACE FUNCTION public.change_log_agents_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_agents_fn$
DECLARE
  v_server uuid;
  v_agent uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
    v_agent := CASE WHEN TG_TABLE_NAME = 'agents' THEN (to_jsonb(OLD) ->> 'id')::uuid ELSE (to_jsonb(OLD) ->> 'agent_id')::uuid END;
  ELSE
    v_server := NEW.server_id;
    v_agent := CASE WHEN TG_TABLE_NAME = 'agents' THEN (to_jsonb(NEW) ->> 'id')::uuid ELSE (to_jsonb(NEW) ->> 'agent_id')::uuid END;
  END IF;
  PERFORM public.change_log_add(v_server, 'server', v_server, NULL, 'agent', v_agent::text,
    CASE WHEN TG_OP = 'DELETE' AND TG_TABLE_NAME = 'agents' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$change_log_agents_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_agents_ins_del AFTER INSERT OR DELETE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.change_log_agents_fn();--> statement-breakpoint
CREATE TRIGGER change_log_agents_upd AFTER UPDATE ON public.agents
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.display_name IS DISTINCT FROM NEW.display_name
    OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.model IS DISTINCT FROM NEW.model
    OR OLD.runtime IS DISTINCT FROM NEW.runtime OR OLD.reasoning_effort IS DISTINCT FROM NEW.reasoning_effort
    OR OLD.execution_mode IS DISTINCT FROM NEW.execution_mode OR OLD.daemon_id IS DISTINCT FROM NEW.daemon_id
    OR OLD.creator_type IS DISTINCT FROM NEW.creator_type OR OLD.creator_id IS DISTINCT FROM NEW.creator_id
    OR OLD.assistant_owner_user_id IS DISTINCT FROM NEW.assistant_owner_user_id
    OR OLD.assistant_reads_dms IS DISTINCT FROM NEW.assistant_reads_dms
    OR OLD.assistant_send_as_owner IS DISTINCT FROM NEW.assistant_send_as_owner
    OR OLD.assistant_paused_at IS DISTINCT FROM NEW.assistant_paused_at
    OR OLD.managed_by_app_install_id IS DISTINCT FROM NEW.managed_by_app_install_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id)
  EXECUTE FUNCTION public.change_log_agents_fn();--> statement-breakpoint
CREATE TRIGGER change_log_server_agent_members AFTER INSERT OR DELETE OR UPDATE OF role ON public.server_agent_members
  FOR EACH ROW EXECUTE FUNCTION public.change_log_agents_fn();--> statement-breakpoint
-- users: profile columns, shown in every server the person belongs to (one row
-- per membership; a person is in a handful of servers).
CREATE OR REPLACE FUNCTION public.change_log_users_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_users_fn$
DECLARE m record;
BEGIN
  FOR m IN SELECT sm.server_id FROM public.server_members sm WHERE sm.user_id = NEW.id LOOP
    PERFORM public.change_log_add(m.server_id, 'server', m.server_id, NULL, 'server_member', NEW.id::text, 'upsert');
  END LOOP;
  RETURN NULL;
END
$change_log_users_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_users_upd AFTER UPDATE ON public.users
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.display_name IS DISTINCT FROM NEW.display_name
    OR OLD.description IS DISTINCT FROM NEW.description OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
    OR OLD.email IS DISTINCT FROM NEW.email OR OLD.retired_at IS DISTINCT FROM NEW.retired_at)
  EXECUTE FUNCTION public.change_log_users_fn();--> statement-breakpoint
-- joint_channel_servers: a projection connecting, changing role or
-- disconnecting changes the local channel row of that server, and the
-- canonical channel's roster for every projection.
CREATE OR REPLACE FUNCTION public.change_log_joint_channel_servers_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_joint_channel_servers_fn$
DECLARE
  r public.joint_channel_servers%ROWTYPE;
  v_canonical uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.change_log_add(r.server_id, 'channel', r.local_channel_id, NULL, 'channel', r.local_channel_id::text, 'upsert');
  SELECT j.canonical_channel_id INTO v_canonical FROM public.joint_channels j WHERE j.id = r.joint_channel_id;
  IF v_canonical IS NOT NULL AND v_canonical IS DISTINCT FROM r.local_channel_id THEN
    PERFORM public.change_log_add(r.server_id, 'channel', v_canonical, NULL, 'channel', v_canonical::text, 'upsert');
  END IF;
  RETURN NULL;
END
$change_log_joint_channel_servers_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_joint_channel_servers AFTER INSERT OR DELETE OR UPDATE OF status, role, local_channel_id ON public.joint_channel_servers
  FOR EACH ROW EXECUTE FUNCTION public.change_log_joint_channel_servers_fn();--> statement-breakpoint
-- joint_channel_members: a person's membership of a joint channel (one row per
-- joint, not per server). The roster change is in the canonical channel's
-- scope; the grant/revoke goes to every one of the person's streams (server_id
-- NULL) naming the canonical channel, which the read side maps to the local
-- projection the viewer's server sees.
CREATE OR REPLACE FUNCTION public.change_log_joint_channel_members_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_joint_channel_members_fn$
DECLARE
  r public.joint_channel_members%ROWTYPE;
  v_canonical uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT j.canonical_channel_id INTO v_canonical FROM public.joint_channels j WHERE j.id = r.joint_channel_id;
  PERFORM public.change_log_add(NULL, 'channel', v_canonical, NULL, 'channel_member',
    v_canonical::text || ':user:' || r.user_id::text, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  PERFORM public.change_log_add(NULL, 'user', r.user_id, NULL, 'channel', v_canonical::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'scope_removed' ELSE 'scope_added' END);
  RETURN NULL;
END
$change_log_joint_channel_members_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_joint_channel_members AFTER INSERT OR DELETE ON public.joint_channel_members
  FOR EACH ROW EXECUTE FUNCTION public.change_log_joint_channel_members_fn();--> statement-breakpoint
-- Per-person state. These tables are written often (thread_follows ~270k
-- updates a day, mostly agents); log only a person's state actually changing.
-- thread_follows: following, unfollowing, done/undone of a thread.
CREATE OR REPLACE FUNCTION public.change_log_thread_follows_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_thread_follows_fn$
DECLARE
  r public.thread_follows%ROWTYPE;
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = r.thread_channel_id;
  PERFORM public.change_log_add(v_server, 'user', r.follower_id, NULL, 'followed_thread', r.thread_channel_id::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$change_log_thread_follows_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_thread_follows_ins AFTER INSERT ON public.thread_follows
  FOR EACH ROW WHEN (NEW.follower_type = 'user')
  EXECUTE FUNCTION public.change_log_thread_follows_fn();--> statement-breakpoint
CREATE TRIGGER change_log_thread_follows_del AFTER DELETE ON public.thread_follows
  FOR EACH ROW WHEN (OLD.follower_type = 'user')
  EXECUTE FUNCTION public.change_log_thread_follows_fn();--> statement-breakpoint
CREATE TRIGGER change_log_thread_follows_upd AFTER UPDATE ON public.thread_follows
  FOR EACH ROW WHEN (NEW.follower_type = 'user' AND (
    OLD.unfollowed_at IS DISTINCT FROM NEW.unfollowed_at OR OLD.done_at IS DISTINCT FROM NEW.done_at))
  EXECUTE FUNCTION public.change_log_thread_follows_fn();--> statement-breakpoint
-- user_channel_inbox_states: a conversation marked done / undone.
CREATE OR REPLACE FUNCTION public.change_log_inbox_states_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_inbox_states_fn$
DECLARE
  r public.user_channel_inbox_states%ROWTYPE;
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = r.channel_id;
  PERFORM public.change_log_add(v_server, 'user', r.user_id, NULL, 'inbox_state', r.channel_id::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$change_log_inbox_states_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_inbox_states_ins_del AFTER INSERT OR DELETE ON public.user_channel_inbox_states
  FOR EACH ROW EXECUTE FUNCTION public.change_log_inbox_states_fn();--> statement-breakpoint
CREATE TRIGGER change_log_inbox_states_upd AFTER UPDATE ON public.user_channel_inbox_states
  FOR EACH ROW WHEN (OLD.done_at IS DISTINCT FROM NEW.done_at)
  EXECUTE FUNCTION public.change_log_inbox_states_fn();--> statement-breakpoint
-- user_channel_read_cursors: logged from the existing BEFORE trigger
-- (read_cursor_mirror_user_trg, 0215) rather than a second trigger on this hot
-- table: same mirror assignment as before, plus one change_log row when the
-- read position actually moves. ref_seq = the new position, so a client can
-- tell a newer read state from an older one.
CREATE OR REPLACE FUNCTION public.read_cursor_mirror_user_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_server uuid;
BEGIN
  NEW.last_read_seq8 := NEW.last_read_seq;
  IF TG_OP = 'INSERT' OR OLD.last_read_seq IS DISTINCT FROM NEW.last_read_seq THEN
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
    PERFORM public.change_log_add(v_server, 'user', NEW.user_id, NULL, 'read_state', NEW.channel_id::text,
      'upsert', NEW.last_read_seq::bigint);
  END IF;
  RETURN NEW;
END;
$$;
