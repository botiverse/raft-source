ALTER TABLE "oauth_clients" ADD COLUMN "owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_owner_agent" ON "oauth_clients" USING btree ("owner_agent_id");