ALTER TABLE "agents" ADD COLUMN "creator_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_agents_creator" ON "agents" USING btree ("server_id","creator_type","creator_id");
