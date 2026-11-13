-- Card messages (RFC 082 §4.6): the pair's "not confirmed in Slack" notice
-- shows at once when a read-back after an unknown outcome cannot read the
-- message or finds an older revision it cannot replace (the T timer stays the
-- fallback when the read-backs looked right). `readback_problem_at` records
-- that on the sync. A nullable column with no default on a table that is
-- still empty everywhere (card updates are behind `message_cards`, off for
-- every Server with a Slack bridge): a catalog-only change. Older server code
-- never names it. Give up after 5 s rather than wait behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_card_edit_syncs" ADD COLUMN "readback_problem_at" timestamp with time zone;