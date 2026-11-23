-- Extended statistics for read_mutations' principal prefix. Without them the
-- planner multiplies the selectivities of server_id, principal_type and
-- principal_id as if independent, so any principal outside the most-common
-- lists is estimated at 1 row. The full-key lookup (server, type, principal,
-- mutation_id) then ties between the unique index and worker_order_idx and can
-- pick worker_order_idx, walking the principal's whole history. Production
-- replica, 11-19: 20k-31k pages and 5-11 s for one lookup, while holding the
-- principal's sequencer lock (admissions behind it hit the 3 s lock_timeout).
-- On a production branch with these statistics: the unique index, 5 pages,
-- 0.25 ms, for every principal tried.
--
-- CREATE STATISTICS only adds catalog metadata; ANALYZE samples a fixed number
-- of rows (not the table size) so the statistics apply with this deploy rather
-- than at autovacuum's next analyze. Both take SHARE UPDATE EXCLUSIVE, which
-- does not block reads or writes. Reverse: DROP STATISTICS.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
CREATE STATISTICS IF NOT EXISTS "read_mutations_principal_stats" (dependencies, ndistinct) ON "server_id", "principal_type", "principal_id" FROM "read_mutations";--> statement-breakpoint
ANALYZE "read_mutations";
