-- Agents taken off a Computer by force stay off until someone binds them on
-- purpose (services/computerAgents.ts): why (`machine_release_reason`,
-- `forced_by_computer_owner`) and when. The machine-online auto-assign skips
-- such an agent; an explicit bind clears both.
--
-- Additive only: two nullable columns rewrite no rows. Bounded lock wait:
-- give up after 5 s (the deploy retries) rather than queue writes behind a
-- long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "machine_release_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "machine_released_at" timestamp with time zone;
