-- schema-snapshot: unchanged (alters a trigger function only)
-- Feature Flag Admin writes server_guest_v0 (its flag, rules and audience
-- members) as feature_flag_admin_operator, which has no privilege on
-- change_log. change_log_guest_access_fn (0458) ran as that caller, so every
-- such write failed with "permission denied for table change_log". The trigger
-- now writes change_log as the function's owner (SECURITY DEFINER); the
-- operator still gets no privilege on change_log. The body is unchanged, its
-- search_path is already pinned in 0458 (public, pg_catalog, pg_temp), and it
-- is a trigger function: nobody can call it directly, and what it logs is
-- constant (one guest_access reset for server_guest_v0), whatever the row.
--
-- PUBLIC loses EXECUTE, as on every other definer-rights function: a trigger
-- fires without it, and appAdminPrivileges.ts refuses any definer function
-- app_admin_operator may execute beyond its list.
ALTER FUNCTION public.change_log_guest_access_fn() SECURITY DEFINER;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON FUNCTION public.change_log_guest_access_fn() FROM PUBLIC;
