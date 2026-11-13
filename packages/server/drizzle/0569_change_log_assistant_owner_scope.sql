-- schema-snapshot: unchanged (replaces a trigger function only)
-- A personal assistant's change rows go to its owner only (#proj-assistant:#15,
-- agentFindableBy): its agent row, and the machine rows whose agent count it
-- changes, are logged in the owner's user scope for its server instead of the
-- server scope. Before this, every member's GET /api/sync/changes delivered a
-- hard delete (op delete) of another person's assistant with its id; upserts
-- were rebuilt per viewer and dropped, so only the id leaked, but no row about
-- someone else's assistant belongs in anyone else's stream.
--
-- The owner is the row's current one: NEW's on insert and update, OLD's on
-- delete. An assistant is linked in the statement after its insert, so its
-- first row is still logged server-wide (rebuilt per viewer, it reaches
-- nobody but its owner). server_agent_members has no owner column; it reads
-- the agent's. Every other agent logs exactly as before (0455).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_agents_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_agents_fn$
DECLARE
  v_server uuid;
  v_agent uuid;
  v_owner uuid;
  v_scope_kind text;
  v_scope_id uuid;
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
  IF TG_TABLE_NAME = 'agents' THEN
    v_owner := CASE WHEN TG_OP = 'DELETE' THEN (to_jsonb(OLD) ->> 'assistant_owner_user_id')::uuid ELSE (to_jsonb(NEW) ->> 'assistant_owner_user_id')::uuid END;
  ELSE
    SELECT a.assistant_owner_user_id INTO v_owner FROM public.agents a WHERE a.id = v_agent;
  END IF;
  IF v_owner IS NULL THEN
    v_scope_kind := 'server';
    v_scope_id := v_server;
  ELSE
    v_scope_kind := 'user';
    v_scope_id := v_owner;
  END IF;
  PERFORM public.change_log_add(v_server, v_scope_kind, v_scope_id, NULL, 'agent', v_agent::text,
    CASE WHEN TG_OP = 'DELETE' AND TG_TABLE_NAME = 'agents' THEN 'delete' ELSE 'upsert' END);
  IF TG_TABLE_NAME = 'agents' THEN
    v_old_machine := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE (to_jsonb(OLD) ->> 'daemon_id')::uuid END;
    v_new_machine := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE (to_jsonb(NEW) ->> 'daemon_id')::uuid END;
    IF v_old_machine IS DISTINCT FROM v_new_machine OR TG_OP <> 'UPDATE' THEN
      IF v_old_machine IS NOT NULL THEN
        PERFORM public.change_log_add(v_server, v_scope_kind, v_scope_id, NULL, 'machine', v_old_machine::text, 'upsert');
      END IF;
      IF v_new_machine IS NOT NULL AND v_new_machine IS DISTINCT FROM v_old_machine THEN
        PERFORM public.change_log_add(v_server, v_scope_kind, v_scope_id, NULL, 'machine', v_new_machine::text, 'upsert');
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$change_log_agents_fn$;
