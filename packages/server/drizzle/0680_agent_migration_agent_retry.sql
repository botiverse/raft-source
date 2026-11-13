-- An agent's own retry of a migration that failed because its workspace was
-- too big (POST /internal/agent-api/migrations/retry). retry_of_migration_id
-- names the failed migration it repeats; the partial unique index allows one
-- retry per migration, race-free. triggered_by_agent_id is the agent that
-- asked, on behalf of initiated_by_user_id. Both null on every existing row.
-- The foreign key to agents (a hot table) takes a short lock on it: 2s.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "retry_of_migration_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "triggered_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_retry_of_migration_id_agent_migrations_id_fk" FOREIGN KEY ("retry_of_migration_id") REFERENCES "public"."agent_migrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_triggered_by_agent_id_agents_id_fk" FOREIGN KEY ("triggered_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migrations_retry_of" ON "agent_migrations" USING btree ("retry_of_migration_id") WHERE "agent_migrations"."retry_of_migration_id" IS NOT NULL;