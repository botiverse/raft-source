-- antiproton held-call approvals (docs/contracts/hosted-agent-approvals.md,
-- "Delivery reports"): when a hold expires, antiproton cannot tell "a card
-- reached a decider and nobody decided" from "it never reached anyone"; only
-- Raft knows. `first_card_at` (the hold's first card, set once),
-- `no_recipient_at` (nobody Raft could send its card to), and the final
-- answer to Raft's delivery report (`delivery_reported_at`,
-- `delivery_report_result`: accepted, not_found or not_pending). Nullable
-- columns with no default and no backfill (holds from before carry no delivery
-- facts): a catalog-only change, one ALTER so the lock is taken once. Older
-- server code never names them. Give up after 5 s rather than queue the hint
-- pulls and card posts behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_runtime_approvals"
	ADD COLUMN "first_card_at" timestamp with time zone,
	ADD COLUMN "no_recipient_at" timestamp with time zone,
	ADD COLUMN "delivery_reported_at" timestamp with time zone,
	ADD COLUMN "delivery_report_result" text;
