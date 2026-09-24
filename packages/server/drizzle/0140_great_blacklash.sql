ALTER TABLE "messages" ADD COLUMN "random_id" text;

-- idx_messages_user_random_id is created by
-- pnpm --filter @botiverse/raft-server db:create-message-random-id-index
-- outside drizzle-kit migrate. The messages table is too large for a
-- transactional CREATE INDEX under staging/prod statement_timeout.
