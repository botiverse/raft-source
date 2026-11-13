-- form.v1 (S2): the values a person submitted through an action card's form
-- sheet. Nullable, no default, no backfill: a catalog-only ALTER (no rewrite,
-- no scan), but ADD COLUMN still takes an ACCESS EXCLUSIVE lock: give up after
-- 5 s rather than queue every action_cards read behind a long transaction.
-- Every existing card keeps NULL.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "submitted_input" jsonb;
