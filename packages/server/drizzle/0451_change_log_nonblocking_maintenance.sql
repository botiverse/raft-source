-- change_log retention without blocking writers (follow-up to change_log,
-- review on #triage:458d78f1). Every logged write inserts into change_log, so
-- any lock on it that conflicts with ROW EXCLUSIVE stalls writes on the eleven
-- logged tables.
--
-- - Create: the day's table is created on its own (no lock on change_log),
--   given its range as a CHECK constraint, then ATTACHed. ATTACH PARTITION takes
--   SHARE UPDATE EXCLUSIVE on change_log, which does not conflict with inserts.
--   It also scans and locks change_log_default, which only receives rows when
--   maintenance has been down for the whole lead time, so it is empty and quick.
--   The CHECK lets ATTACH skip scanning the new table; it is dropped afterwards.
-- - Drop: DETACH PARTITION ... CONCURRENTLY is not allowed while a default
--   partition exists, and the default partition stays (a missing day must not
--   fail business writes). So a plain DETACH, which does lock change_log, runs
--   only when the caller allows it (the server's hourly maintenance allows it
--   18:00-22:00 UTC, the daily low) with lock_timeout 100ms. If the lock is not
--   free it gives up (lock_busy) and the next hour retries; writers wait at most
--   100ms, once a day.
-- Each DDL runs in its own subtransaction, so one busy lock does not undo the
-- days already done.
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DROP FUNCTION IF EXISTS public.change_log_maintain(integer, integer);--> statement-breakpoint
CREATE FUNCTION public.change_log_maintain(ahead_days integer DEFAULT 14, keep_days integer DEFAULT 8, allow_drop boolean DEFAULT false)
RETURNS TABLE (action text, partition_name text)
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_maintain$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  part text;
  lo timestamptz;
  hi timestamptz;
  child record;
  child_day date;
BEGIN
  FOR d IN SELECT generate_series(today - 1, today + ahead_days, interval '1 day')::date LOOP
    part := 'change_log_p' || to_char(d, 'YYYYMMDD');
    CONTINUE WHEN to_regclass('public.' || part) IS NOT NULL;
    lo := d::timestamp AT TIME ZONE 'UTC';
    hi := (d + 1)::timestamp AT TIME ZONE 'UTC';
    IF EXISTS (SELECT 1 FROM public.change_log_default WHERE created_at >= lo AND created_at < hi) THEN
      action := 'skipped_default_has_rows'; partition_name := part; RETURN NEXT;
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('CREATE TABLE public.%I (LIKE public.change_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (created_at >= %L AND created_at < %L)',
        part, part || '_range', lo, hi);
      EXECUTE format('ALTER TABLE public.change_log ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', part, part || '_range');
      action := 'created'; partition_name := part; RETURN NEXT;
    EXCEPTION WHEN lock_not_available THEN
      action := 'lock_busy'; partition_name := part; RETURN NEXT;
    END;
  END LOOP;
  IF NOT allow_drop THEN
    RETURN;
  END IF;
  PERFORM set_config('lock_timeout', '100ms', true);
  FOR child IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.change_log'::regclass AND c.relname ~ '^change_log_p[0-9]{8}$'
  LOOP
    child_day := to_date(substr(child.relname, 13), 'YYYYMMDD');
    CONTINUE WHEN child_day + 1 > today - keep_days;
    BEGIN
      EXECUTE format('ALTER TABLE public.change_log DETACH PARTITION public.%I', child.relname);
      action := 'detached'; partition_name := child.relname; RETURN NEXT;
    EXCEPTION WHEN lock_not_available THEN
      action := 'lock_busy'; partition_name := child.relname; RETURN NEXT;
      CONTINUE;
    END;
    -- Detached: no longer part of change_log, so dropping it locks nothing writers use.
    EXECUTE format('DROP TABLE public.%I', child.relname);
    action := 'dropped'; partition_name := child.relname; RETURN NEXT;
  END LOOP;
  -- A day detached on an earlier run whose DROP did not happen.
  FOR child IN
    SELECT c.relname FROM pg_class c
    WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relname ~ '^change_log_p[0-9]{8}$'
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('DROP TABLE public.%I', child.relname);
    action := 'dropped'; partition_name := child.relname; RETURN NEXT;
  END LOOP;
END
$change_log_maintain$;
