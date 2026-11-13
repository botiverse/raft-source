-- Card messages (RFC 082 §4.6): the pair's card-edit notices are a projection
-- of its syncs' current state, recomputed (by pair: binding id and epoch) in
-- every transaction that changes a sync and when the setup panel reads them.
-- One btree index on `external_card_edit_syncs`, a table added in the previous
-- migration and still empty everywhere (only card updates behind the
-- `message_cards` flag write it, off for every Server with a Slack bridge), so
-- building it is instant; a plain CREATE INDEX, not CONCURRENTLY. Older server
-- code never reads it. The build blocks writes to that table only: give up
-- after 5 s rather than wait behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "idx_external_card_edit_sync_pair" ON "external_card_edit_syncs" USING btree ("binding_id","binding_epoch","state");