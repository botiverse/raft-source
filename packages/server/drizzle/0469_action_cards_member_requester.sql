-- action_cards can be asked for by a person (task #10 #proj-commercial): a
-- member or admin asks an owner for seats, or for Pro, with a card instead of
-- an agent. requester_agent_id becomes nullable, requester_user_id is added,
-- and exactly one of the two is set.
--
-- Part 1 of 2. Everything here is catalog-only (no rewrite, no scan of
-- action_cards, ~23k rows in production): DROP NOT NULL, ADD COLUMN without a
-- default, and the foreign key and CHECK added NOT VALID, so they bind new and
-- updated rows from now on. The next migration validates both under SHARE
-- UPDATE EXCLUSIVE, which reads and writes don't wait for. The index is small
-- (partial: only person-requested rows, none yet). The lock wait is bounded so
-- a long transaction makes the deploy retry instead of queueing card reads.
--
-- Rollback: rows with requester_user_id exist only while the server flag
-- pro_seat_add is on. Turn the flag off and void those cards before rolling
-- back past this release; the previous release's code expects
-- requester_agent_id to be set.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "action_cards" ALTER COLUMN "requester_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "action_cards" ADD COLUMN "requester_user_id" uuid;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_action_cards_requester_user" ON "action_cards" USING btree ("requester_user_id","created_at") WHERE "action_cards"."requester_user_id" is not null;--> statement-breakpoint
ALTER TABLE "action_cards" ADD CONSTRAINT "action_cards_one_requester" CHECK (num_nonnulls("action_cards"."requester_agent_id", "action_cards"."requester_user_id") = 1) NOT VALID;
