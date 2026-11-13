-- change_log, batch 1b (Tenny, #triage:458d78f1, after the v1.21.35 reconnect
-- spike): machines and the per-person sidebar order. The server list of
-- machines was the biggest full reload after a reconnect (13.5k s of handler
-- time in one deploy). Writers and scopes follow the change_log migration.
--
-- machine (scope server): daemons' descriptive columns, computers (attach,
-- rename, revoke), computer_upgrade_requests (created, resolved), and an agent
-- moving between machines (the list shows each machine's agent count).
-- daemons.last_heartbeat and computers.last_used_* are liveness, not logged;
-- online status lives in Redis and travels on the presence subscription.
--
-- sidebar_order (scope user, the member's server): the pinned, order, hidden
-- DM, section and panel-tab columns of server_members, i.e. what
-- GET /api/servers/:id/sidebar-order returns. json columns compare as text.
-- server_order (scope user, every stream): users.server_switcher_order.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_machine_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_machine_fn$
DECLARE
  j jsonb;
  v_machine uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN j := to_jsonb(OLD); ELSE j := to_jsonb(NEW); END IF;
  v_machine := CASE WHEN TG_TABLE_NAME = 'daemons' THEN (j ->> 'id')::uuid ELSE (j ->> 'machine_id')::uuid END;
  -- A computer credential not yet bound to a machine is not a list row.
  IF v_machine IS NULL THEN RETURN NULL; END IF;
  PERFORM public.change_log_add((j ->> 'server_id')::uuid, 'server', (j ->> 'server_id')::uuid, NULL, 'machine', v_machine::text,
    CASE WHEN TG_OP = 'DELETE' AND TG_TABLE_NAME = 'daemons' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$change_log_machine_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_daemons_ins_del AFTER INSERT OR DELETE ON public.daemons
  FOR EACH ROW EXECUTE FUNCTION public.change_log_machine_fn();--> statement-breakpoint
CREATE TRIGGER change_log_daemons_upd AFTER UPDATE ON public.daemons
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.runtimes::text IS DISTINCT FROM NEW.runtimes::text OR OLD.hostname IS DISTINCT FROM NEW.hostname
    OR OLD.os IS DISTINCT FROM NEW.os OR OLD.device_class IS DISTINCT FROM NEW.device_class
    OR OLD.host_provider IS DISTINCT FROM NEW.host_provider OR OLD.os_release IS DISTINCT FROM NEW.os_release
    OR OLD.os_id IS DISTINCT FROM NEW.os_id OR OLD.os_id_like::text IS DISTINCT FROM NEW.os_id_like::text
    OR OLD.install_kind IS DISTINCT FROM NEW.install_kind OR OLD.node_on_path IS DISTINCT FROM NEW.node_on_path
    OR OLD.daemon_version IS DISTINCT FROM NEW.daemon_version OR OLD.computer_version IS DISTINCT FROM NEW.computer_version
    OR OLD.first_connected_at IS DISTINCT FROM NEW.first_connected_at OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id)
  EXECUTE FUNCTION public.change_log_machine_fn();--> statement-breakpoint
CREATE TRIGGER change_log_computers_ins_del AFTER INSERT OR DELETE ON public.computers
  FOR EACH ROW EXECUTE FUNCTION public.change_log_machine_fn();--> statement-breakpoint
CREATE TRIGGER change_log_computers_upd AFTER UPDATE ON public.computers
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
    OR OLD.machine_id IS DISTINCT FROM NEW.machine_id OR OLD.attached_by_user_id IS DISTINCT FROM NEW.attached_by_user_id)
  EXECUTE FUNCTION public.change_log_machine_fn();--> statement-breakpoint
CREATE TRIGGER change_log_computer_upgrade_requests AFTER INSERT OR DELETE OR UPDATE OF outcome, resolved_at, observed_version ON public.computer_upgrade_requests
  FOR EACH ROW EXECUTE FUNCTION public.change_log_machine_fn();--> statement-breakpoint
-- agents: as in the change_log migration, plus the machine rows an agent
-- leaves and joins (their agent counts change).
CREATE OR REPLACE FUNCTION public.change_log_agents_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_agents_fn$
DECLARE
  v_server uuid;
  v_agent uuid;
  v_old_machine uuid;
  v_new_machine uuid;
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
  IF TG_TABLE_NAME = 'agents' THEN
    v_old_machine := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE (to_jsonb(OLD) ->> 'daemon_id')::uuid END;
    v_new_machine := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE (to_jsonb(NEW) ->> 'daemon_id')::uuid END;
    IF v_old_machine IS DISTINCT FROM v_new_machine OR TG_OP <> 'UPDATE' THEN
      IF v_old_machine IS NOT NULL THEN
        PERFORM public.change_log_add(v_server, 'server', v_server, NULL, 'machine', v_old_machine::text, 'upsert');
      END IF;
      IF v_new_machine IS NOT NULL AND v_new_machine IS DISTINCT FROM v_old_machine THEN
        PERFORM public.change_log_add(v_server, 'server', v_server, NULL, 'machine', v_new_machine::text, 'upsert');
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$change_log_agents_fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_sidebar_order_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_sidebar_order_fn$
BEGIN
  PERFORM public.change_log_add(NEW.server_id, 'user', NEW.user_id, NULL, 'sidebar_order', NEW.server_id::text, 'upsert');
  RETURN NULL;
END
$change_log_sidebar_order_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_server_members_sidebar AFTER UPDATE ON public.server_members
  FOR EACH ROW WHEN (
    OLD.pinned_refs::text IS DISTINCT FROM NEW.pinned_refs::text
    OR OLD.pinned_channel_ids::text IS DISTINCT FROM NEW.pinned_channel_ids::text
    OR OLD.pinned_agent_ids::text IS DISTINCT FROM NEW.pinned_agent_ids::text
    OR OLD.pinned_order::text IS DISTINCT FROM NEW.pinned_order::text
    OR OLD.pinned_version IS DISTINCT FROM NEW.pinned_version
    OR OLD.hidden_dm_ids::text IS DISTINCT FROM NEW.hidden_dm_ids::text
    OR OLD.channel_panel_tab_order::text IS DISTINCT FROM NEW.channel_panel_tab_order::text
    OR OLD.agent_panel_tab_order::text IS DISTINCT FROM NEW.agent_panel_tab_order::text
    OR OLD.channel_side_layout IS DISTINCT FROM NEW.channel_side_layout
    OR OLD.sidebar_channel_order::text IS DISTINCT FROM NEW.sidebar_channel_order::text
    OR OLD.sidebar_agent_order::text IS DISTINCT FROM NEW.sidebar_agent_order::text
    OR OLD.sidebar_dm_order::text IS DISTINCT FROM NEW.sidebar_dm_order::text
    OR OLD.sidebar_channel_sort_mode IS DISTINCT FROM NEW.sidebar_channel_sort_mode
    OR OLD.sidebar_joint_channel_sort_mode IS DISTINCT FROM NEW.sidebar_joint_channel_sort_mode
    OR OLD.sidebar_dm_sort_mode IS DISTINCT FROM NEW.sidebar_dm_sort_mode
    OR OLD.sidebar_pinned_sort_mode IS DISTINCT FROM NEW.sidebar_pinned_sort_mode
    OR OLD.sidebar_custom_sections::text IS DISTINCT FROM NEW.sidebar_custom_sections::text
    OR OLD.sidebar_section_order::text IS DISTINCT FROM NEW.sidebar_section_order::text
    OR OLD.sidebar_section_placements::text IS DISTINCT FROM NEW.sidebar_section_placements::text
    OR OLD.sidebar_sections_version IS DISTINCT FROM NEW.sidebar_sections_version)
  EXECUTE FUNCTION public.change_log_sidebar_order_fn();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_server_order_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_server_order_fn$
BEGIN
  PERFORM public.change_log_add(NULL, 'user', NEW.id, NULL, 'server_order', NEW.id::text, 'upsert');
  RETURN NULL;
END
$change_log_server_order_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_users_server_order AFTER UPDATE ON public.users
  FOR EACH ROW WHEN (
    OLD.server_switcher_order::text IS DISTINCT FROM NEW.server_switcher_order::text
    OR OLD.server_order_version IS DISTINCT FROM NEW.server_order_version)
  EXECUTE FUNCTION public.change_log_server_order_fn();
