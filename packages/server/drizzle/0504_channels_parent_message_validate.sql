-- Phase 2: validate all history in a separate deploy transaction. The deploy
-- migrator uses singleton phases, releasing phase 1's ACCESS EXCLUSIVE lock
-- before this SHARE UPDATE EXCLUSIVE scan. Reads and ordinary writes continue.
-- Any invalid old row fails deployment before the cache-only reader starts;
-- repair requires a separate reviewed operation, never an automatic deletion.
-- Validation uses the bounded migration scan budget, not the ops query budget.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "channels" VALIDATE CONSTRAINT "channels_parent_message_requires_channel";
