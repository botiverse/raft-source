-- change_log: changes that take something AWAY from a viewer who is not in the
-- changed row's own scope (Tenny's review of GET /api/sync/changes, #11459).
-- The read side filters channel rows by what the viewer can see NOW, so a
-- channel that stops being visible to them would never send its own change.
--
-- channels: a public channel that stops being public for the server's
-- non-guest members (made private, #all hidden, which is the same type change,
-- or deleted) also logs `channel_public_lost` in the server scope; a channel
-- guests could read that stops being readable logs `channel_guest_lost`. The
-- read side delivers the first to non-guests and the second to guests, as a
-- rebuilt row or a delete. Both apply to public channels only: a private
-- channel's id is never broadcast to the server.
--
-- joint_channel_servers: a projection leaving the joint (status no longer
-- active, or the row deleted) revokes the local channel from every member of
-- the joint, in that server's stream (scope_removed). Their channel_humans
-- rows on the projection may stay, so nothing else would tell them.
--
-- server_members: a role change to or from guest changes what the person can
-- see everywhere in the server (channels, members, agents, machines), so it
-- resets their stream there (op reset in their user scope); leaving the server
-- already logs scope_removed.
--
-- Locks: this replaces the trigger functions of channels,
-- joint_channel_servers and server_members (the triggers stay); it contends
-- with writes to those three tables, so deploy it in the low period. The xid
-- index is a separate migration (0457) that locks only change_log.
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
  IF TG_OP <> 'INSERT' AND OLD.type = 'channel' THEN
    -- Non-guest members saw every public channel; #all is hidden by turning it
    -- private, so the type change covers it.
    IF TG_OP = 'DELETE' OR NEW.type <> 'channel' OR NEW.deleted_at IS NOT NULL THEN
      PERFORM public.change_log_add(OLD.server_id, 'server', OLD.server_id, NULL, 'channel_public_lost', OLD.id::text, 'upsert');
    END IF;
    IF OLD.guest_visible AND (TG_OP = 'DELETE' OR NOT NEW.guest_visible OR NEW.type <> 'channel' OR NEW.deleted_at IS NOT NULL) THEN
      PERFORM public.change_log_add(OLD.server_id, 'server', OLD.server_id, NULL, 'channel_guest_lost', OLD.id::text, 'upsert');
    END IF;
  END IF;
  RETURN NULL;
END
$change_log_channels_fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_joint_channel_servers_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_joint_channel_servers_fn$
DECLARE
  r public.joint_channel_servers%ROWTYPE;
  v_canonical uuid;
  m record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.change_log_add(r.server_id, 'channel', r.local_channel_id, NULL, 'channel', r.local_channel_id::text, 'upsert');
  SELECT j.canonical_channel_id INTO v_canonical FROM public.joint_channels j WHERE j.id = r.joint_channel_id;
  IF v_canonical IS NOT NULL AND v_canonical IS DISTINCT FROM r.local_channel_id THEN
    PERFORM public.change_log_add(r.server_id, 'channel', v_canonical, NULL, 'channel', v_canonical::text, 'upsert');
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.status = 'active' AND (TG_OP = 'DELETE' OR NEW.status <> 'active') THEN
    FOR m IN SELECT jm.user_id FROM public.joint_channel_members jm WHERE jm.joint_channel_id = OLD.joint_channel_id LOOP
      PERFORM public.change_log_add(OLD.server_id, 'user', m.user_id, NULL, 'channel', OLD.local_channel_id::text, 'scope_removed');
    END LOOP;
  END IF;
  RETURN NULL;
END
$change_log_joint_channel_servers_fn$;--> statement-breakpoint
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
  ELSIF (OLD.role = 'guest') IS DISTINCT FROM (NEW.role = 'guest') THEN
    PERFORM public.change_log_add(r.server_id, 'user', r.user_id, NULL, 'server', r.server_id::text, 'reset');
  END IF;
  RETURN NULL;
END
$change_log_server_members_fn$;
