-- change_log by xid, for GET /api/sync/changes' late rows (rows whose
-- transaction committed after the previous read passed their seq). That read
-- is bounded by xid (previous horizon <= xid < current horizon), so it walks
-- this index in xid order and stops after the cap, however old or forged the
-- client's horizon is.
--
-- Its own migration so it locks only change_log: CREATE INDEX on the
-- partitioned parent builds one index per partition (the table is days old
-- and small; CONCURRENTLY is not available on a partitioned parent).
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '300s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS change_log_xid_idx ON public.change_log (xid);
