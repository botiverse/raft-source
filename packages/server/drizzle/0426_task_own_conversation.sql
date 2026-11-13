-- Task v2: task conversations are created lazily, like threads (decided
-- 2026-10-21). A task created with task v2 conversations on has no host
-- message and, until the first action that needs it, no conversation either;
-- `own_conversation` says its discussion is its own conversation anyway, so it
-- is never mistaken for a pre-thread orphan (no host message, no
-- conversation). Constant default: a metadata-only change, no table rewrite.
-- No backfill: every existing task v2 row already has its conversation.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "own_conversation" boolean DEFAULT false NOT NULL;
