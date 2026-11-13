-- action_cards person requester, part 2 of 2: validate the foreign key and the
-- one-requester CHECK added NOT VALID by the previous migration. VALIDATE
-- CONSTRAINT takes SHARE UPDATE EXCLUSIVE on action_cards (and ROW SHARE on
-- users for the foreign key): it scans while reads, inserts and updates
-- continue. Every existing row has requester_agent_id set
-- and requester_user_id NULL, so both hold. Production check before deploy:
--   SELECT count(*) FROM action_cards WHERE requester_agent_id IS NULL;   -- expect 0
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "action_cards" VALIDATE CONSTRAINT "action_cards_requester_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "action_cards" VALIDATE CONSTRAINT "action_cards_one_requester";
