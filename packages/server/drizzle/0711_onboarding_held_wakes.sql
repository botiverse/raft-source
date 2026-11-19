-- Onboarding wakes held for a runtime driver that exits after every turn
-- (services/onboardingHeldWakes.ts). The owner opener ledger and the #all
-- greeting are synthetic seq-0 messages no read can return, so an old Cursor,
-- Antigravity, Gemini or Copilot driver kept them pending and restarted a turn
-- for them after every turn. The server now sends them to such an agent
-- `transient`, only once its process has exited idle; until then the wake
-- waits here. One row per agent and kind; the delivery that takes a row
-- deletes it. New table only: nothing existing changes.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "onboarding_held_wakes" (
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" jsonb NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_held_wakes_agent_id_kind_pk" PRIMARY KEY("agent_id","kind")
);
--> statement-breakpoint
ALTER TABLE "onboarding_held_wakes" ADD CONSTRAINT "onboarding_held_wakes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
