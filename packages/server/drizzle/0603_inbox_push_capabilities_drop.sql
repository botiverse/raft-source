-- WeChat line removal, step 6 of 6: the push registration's declared
-- capabilities (agent_inbox_push_registrations.capabilities, 0552; only the
-- WeChat line used them) go. configured_by stays: the runtime provider still
-- sets a personal assistant's registration.
--
-- Locks: ACCESS EXCLUSIVE on agent_inbox_push_registrations, once, for the
-- catalog change only (dropping a column rewrites nothing); it waits at most
-- 2 s (the deploy runner retries a lock timeout). Where 0561's first version
-- already dropped the column (staging), the DO block takes no lock.
--
-- schema-snapshot: unchanged (schema.ts no longer declares the column; 0561's first version dropped it)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.agent_inbox_push_registrations'::regclass AND attname = 'capabilities' AND attnum > 0 AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE "agent_inbox_push_registrations" DROP COLUMN "capabilities"';
  END IF;
END
$$;
