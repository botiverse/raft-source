-- Card messages (RFC 082 §4.2): the card update's `idempotencyKey`, kept on
-- the revision it wrote, unique per message, so the same key answers that
-- revision again instead of writing another. A nullable column with no default
-- (a catalog-only change) and a unique index on a table that only card sends
-- and updates write, behind the `message_cards` flag (off everywhere); NULL
-- keys (revision 1, keyless updates) are distinct and never collide. No
-- backfill. Older server code never names the column, so rolling back leaves
-- it unused. Both statements lock `message_card_revisions` (the index build
-- blocks its writes for the build): give up after 5 s rather than queue card
-- sends behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "message_card_revisions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_message_card_revisions_idempotency_key" ON "message_card_revisions" USING btree ("message_id","idempotency_key");
