-- Vacuum read_mutations at ~1% change instead of the global 20%.
--
-- Why: read_mutations keeps every terminal mutation for 90 days (≈26.7M rows
-- on 2026-10-28). With the defaults it needs ≈5.3M dead tuples before
-- autovacuum runs; it had run once ever (2026-10-25 00:29Z) and had 2.1M dead
-- tuples three days later. Every mutation that leaves 'admitted'/'executing'
-- leaves a dead entry in read_mutations_worker_pending_idx, and only vacuum
-- removes it: on 2026-10-28 that partial index was 376 MB while it covered 0
-- pending rows. claimNextFairReadMutation's DISTINCT ON walks the whole index,
-- so it stays fast only while index kill bits hide the dead entries. Kill bits
-- are not WAL-logged here (wal_log_hints = off), so when those pages are
-- re-read the walk turns into a heap visit per dead entry: the drain then hit
-- the 15 s statement_timeout for 1–3 minutes at a time (6 bursts 10-27..10-28,
-- #proj-data:#9).
--
-- At 0.01 + 10000 (≈277k dead tuples at the current size) autovacuum runs
-- about twice a day at the current churn and keeps the partial index small.
-- Cost: above PostgreSQL's index-vacuum bypass each run scans every index in
-- full (≈13 GB on 2026-10-28); see 0291 for the same trade-off on messages.
-- That is accepted here because the alternative is the drain stalling.
--
-- Storage parameters only: this does not run VACUUM or touch data. The
-- existing backlog was cleared by a separate, approved manual step on
-- 2026-10-28 (VACUUM 22:42Z: 2.33M dead tuples -> 183; REINDEX INDEX
-- CONCURRENTLY 22:51Z: read_mutations_worker_pending_idx 376 MB -> 160 kB).
ALTER TABLE "read_mutations" SET (
	autovacuum_vacuum_scale_factor = 0.01,
	autovacuum_vacuum_threshold = 10000
);
