ALTER TABLE "server_members" ADD COLUMN "setup_handoff_acknowledged_at" timestamp with time zone;--> statement-breakpoint
-- Seed the new ack from the ONE piece of evidence the old data actually contains: if a
-- briefing was sent, the owner must have pressed Let's Go (that click is what sent it).
-- Nothing is invented for rows without it — a row where the briefing never went out cannot
-- prove the button was pressed, so it stays NULL and the owner may see the handoff once more.
-- Grandfathered servers are excluded by eligibility, not by faking an acknowledgment here.
UPDATE "server_members"
SET "setup_handoff_acknowledged_at" = COALESCE("onboarding_owner_opener_v2_sent_at", "onboarding_dm_sent_at")
WHERE "setup_handoff_acknowledged_at" IS NULL
  AND COALESCE("onboarding_owner_opener_v2_sent_at", "onboarding_dm_sent_at") IS NOT NULL;
