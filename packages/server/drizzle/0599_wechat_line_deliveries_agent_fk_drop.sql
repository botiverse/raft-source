-- WeChat line removal, step 2 of 6 (0561 is step 1): the foreign key from
-- assistant_wechat_line_deliveries (0552, the WeChat line's read cursor) to
-- agents, dropped on its own so that the one step that locks agents is as
-- short as it can be; 0600 then drops the table without touching agents.
--
-- Where 0561's first version already dropped the table (staging), ALTER TABLE
-- IF EXISTS takes no lock and does nothing.
--
-- Locks: ACCESS EXCLUSIVE on assistant_wechat_line_deliveries (no code reads
-- or writes it) and ACCESS EXCLUSIVE on agents, for removing the foreign key's
-- triggers there (measured on PostgreSQL 16): every agents read and write
-- waits while it is held or waited for. So it holds no other lock, waits at
-- most 2 s (the deploy runner retries a lock timeout) and keeps the lock only
-- for the catalog change.
--
-- schema-snapshot: unchanged (schema.ts no longer declares the table; 0561's first version dropped it)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE IF EXISTS "assistant_wechat_line_deliveries" DROP CONSTRAINT IF EXISTS "assistant_wechat_line_deliveries_agent_id_agents_id_fk";
