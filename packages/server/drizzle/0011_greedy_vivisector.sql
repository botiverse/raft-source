DROP INDEX "idx_agents_server_name";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_server_name" ON "agents" USING btree ("server_id","name") WHERE deleted_at is null;