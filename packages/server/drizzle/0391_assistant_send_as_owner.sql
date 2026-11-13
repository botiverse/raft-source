ALTER TABLE "agents" ADD COLUMN "assistant_send_as_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delegated_by_agent_id" uuid;