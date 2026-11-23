-- An agent may change a channel member's channel role on its own authority
-- (Agent API `POST /channels/member-role`, `raft channel set-role`; product
-- decision 2026-11-17). A role event now names its requester as a person or
-- an agent: requester_user_id becomes nullable, requester_agent_id is added
-- (agents rows are never hard-deleted, so RESTRICT like the user key), and
-- exactly one of them is set. Every existing row has requester_user_id, so
-- the check holds for them.
--
-- channel_membership_role_events is small (one row per role change). Adding
-- the foreign key takes SHARE ROW EXCLUSIVE on agents for the instant of the
-- ALTER (the new column is all NULL, so validating it reads nothing); under a
-- short lock timeout so agent writes never queue behind it (the deploy
-- retries). Older servers keep writing requester_user_id, which the check
-- accepts.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ALTER COLUMN "requester_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD COLUMN "requester_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD CONSTRAINT "channel_membership_role_events_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_membership_role_events" ADD CONSTRAINT "channel_membership_role_events_requester_check" CHECK (num_nonnulls("channel_membership_role_events"."requester_user_id", "channel_membership_role_events"."requester_agent_id") = 1);