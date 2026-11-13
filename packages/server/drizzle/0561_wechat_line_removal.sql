-- WeChat messages go back to the assistant's main line (design "微信接入 Ottie",
-- #proj-assistant:742b8915): the WeChat line of 0552_wechat_line_credentials is
-- removed. This migration touches agent_turn_triggers only: its `wechat` rows
-- go, the primary key is agent_id again (what v1.21.49 and older replicas
-- write with ON CONFLICT ("agent_id")), and line / idle_observed_at / the line
-- CHECK are dropped.
--
-- The rest of 0552 is dropped one table per migration at the end of the
-- journal (0599–0603), each one a no-op where it is already gone. The first
-- version of this file did all of it in one transaction that locked
-- agent_credentials and agent_turn_triggers up front and then dropped
-- assistant_wechat_line_deliveries (which also locks agents for its foreign
-- key): it deadlocked with agent authentication three times in production
-- (v1.21.50, 2026-11-04) and rolled back. Databases that ran that version
-- (staging) don't run this one again: drizzle applies only migrations newer
-- than its last recorded one.
--
-- agent_turn_triggers keeps wechat_restricted / wechat_allowed_channel_id under
-- their 0550 names (0550 is released; older replicas and a rollback write
-- them): they now mean "the turn carries a WeChat message" and "the DM its
-- replies are mirrored from" (schema.ts), not a read restriction.
--
-- Locks: ACCESS EXCLUSIVE on agent_turn_triggers alone, taken first so the
-- transaction never upgrades a weaker lock it already holds (no other table is
-- locked, so it can't be part of a deadlock cycle). It waits at most 2 s
-- (the deploy runner retries a lock timeout); every statement after it works
-- on a table of at most one row per personal assistant.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "agent_turn_triggers" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "agent_turn_triggers" WHERE "line" <> 'main';--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" DROP CONSTRAINT "agent_turn_triggers_line_valid";--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" DROP CONSTRAINT "agent_turn_triggers_agent_id_line_pk";--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" ADD PRIMARY KEY ("agent_id");--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" DROP COLUMN "line";--> statement-breakpoint
ALTER TABLE "agent_turn_triggers" DROP COLUMN "idle_observed_at";
