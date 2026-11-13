-- WeChat line removal, step 4 of 6: every live WeChat line credential
-- (agent_credentials.session_scope, 0552) is revoked before 0602 drops the
-- columns that scope it, so none can outlive its scope as an ordinary agent
-- credential.
--
-- No lock is held across this and the drop. That is safe because nothing
-- writes session_scope: no version that runs against these databases declares
-- it in schema.ts (v1.21.49 predates it; every version from the one that
-- removed the WeChat line on has dropped it), so no credential with a scope can
-- be created between this commit and 0602's. Production had 0 rows with session_scope set
-- (read-only count, 2026-11-04 22:43Z), so this is expected to update none.
--
-- Locks: ROW EXCLUSIVE on agent_credentials, as any UPDATE does: reads and
-- other writes go on. The WHERE reads the whole table once (no index on
-- session_scope; one row per credential). Where 0561's first version already
-- dropped the column (staging), the DO block checks the catalog and does
-- nothing.
--
-- schema-snapshot: unchanged (data only)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '10min';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.agent_credentials'::regclass AND attname = 'session_scope' AND attnum > 0 AND NOT attisdropped
  ) THEN
    UPDATE "agent_credentials" SET "revoked_at" = now(), "revoked_reason" = 'wechat_line_removed'
     WHERE "session_scope" IS NOT NULL AND "revoked_at" IS NULL;
  END IF;
END
$$;
