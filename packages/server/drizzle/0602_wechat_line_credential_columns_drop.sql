-- WeChat line removal, step 5 of 6: the line credential columns of
-- agent_credentials (0552: session_scope, bound_channel_id, bound_turn_id,
-- expires_at, parent_credential_id) and their shape CHECK go. 0601 revoked any
-- credential they scoped; nothing writes them (see 0601).
--
-- Locks: one ALTER TABLE, so ACCESS EXCLUSIVE on agent_credentials is taken
-- once, with no other lock held, and kept only for the catalog change (dropping
-- a column or a CHECK rewrites nothing). While it waits, agent authentication
-- (which reads agent_credentials) waits behind it, so it waits at most 2 s and
-- fails instead (the deploy runner retries a lock timeout). Where 0561's first
-- version already dropped the columns (staging), the DO block checks the
-- catalog and takes no lock.
--
-- schema-snapshot: unchanged (schema.ts no longer declares the columns; 0561's first version dropped them)
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.agent_credentials'::regclass AND attname = 'session_scope' AND attnum > 0 AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE "agent_credentials"'
      ' DROP CONSTRAINT IF EXISTS "agent_credentials_session_scope_shape",'
      ' DROP COLUMN IF EXISTS "session_scope",'
      ' DROP COLUMN IF EXISTS "bound_channel_id",'
      ' DROP COLUMN IF EXISTS "bound_turn_id",'
      ' DROP COLUMN IF EXISTS "expires_at",'
      ' DROP COLUMN IF EXISTS "parent_credential_id"';
  END IF;
END
$$;
