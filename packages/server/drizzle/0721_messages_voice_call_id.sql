-- Raft voice calls (#wg-runtime-form:#22): the call that posted a message in
-- the agent's name (tell_user, a late answer, the call's record). The voice
-- model wrote those words, not the agent, so the agent reads them with
-- `posted_by=voice_call` rather than as something it said.
--
-- Nullable, no default, no foreign key, no index: a catalog-only change
-- (ACCESS EXCLUSIVE on messages for the instant of the ALTER, no rewrite, no
-- scan). Older servers neither read nor write the column. Under a short lock
-- timeout (the deploy retries) rather than queueing message writes behind a
-- long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_call_id" uuid;
