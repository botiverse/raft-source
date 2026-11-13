-- WeChat line removal, step 3 of 6: the WeChat line's read cursor
-- (assistant_wechat_line_deliveries, 0552) goes. Its foreign key to agents went
-- in 0599, so this locks nothing but the table, which no code reads or writes.
-- A no-op where the table is already gone (staging).
--
-- schema-snapshot: unchanged (schema.ts no longer declares the table; 0561's first version dropped it)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE IF EXISTS "assistant_wechat_line_deliveries" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "assistant_wechat_line_deliveries";
