-- schema-snapshot: unchanged (drops triggers and a trigger function only)
-- server_guest_v0 is retired from the code: since #13829 (retire Guest joining)
-- no server or web code reads it, so changing the flag, its rules or an
-- audience it names no longer changes what any Guest can see. The guest_access
-- trigger (0458, definer rights since 0583) existed only to log one
-- guest_access reset per such change; it goes, with its function. The flag row
-- itself stays (deleting it is a separate, approved production step).
--
-- Rows it already wrote stay in change_log until retention drops them;
-- syncChanges still applies them to guest viewers, as before.
--
-- Rolling deploy and rollback: no code writes or depends on these triggers.
-- Older code only reads guest_access rows, and with the trigger gone there
-- are simply no new ones; a flag edit (Feature Flag Admin) still succeeds.
--
-- Locks: DROP TRIGGER takes ACCESS EXCLUSIVE on feature_flags,
-- feature_flag_rules and feature_flag_audience_members, each a small table,
-- held to commit; no scan, no rewrite. Under a short lock timeout (the deploy
-- retries) rather than queueing flag reads behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_guest_access_flags ON public.feature_flags;--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_guest_access_rules ON public.feature_flag_rules;--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_guest_access_audience_members ON public.feature_flag_audience_members;--> statement-breakpoint
DROP FUNCTION IF EXISTS public.change_log_guest_access_fn();
