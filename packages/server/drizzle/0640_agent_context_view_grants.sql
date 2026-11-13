-- View Context grants (#wg-ax:#15): a server owner or admin lets one ordinary
-- agent search and read other agents' View Context. One new, empty table with
-- all its constraints (no NOT VALID / VALIDATE split: the table is empty). Only
-- the grant routes write it, behind agent_context_view_v0, and older server
-- code never names it, so rolling back leaves it unused. The foreign keys take
-- SHARE ROW EXCLUSIVE locks on `servers`, `agents` and `users` (hot): give up
-- after 2 s rather than queue reads behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
CREATE TABLE "agent_context_view_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"granter_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "agent_context_view_grants_revoked_by_needs_revoked_at" CHECK ("agent_context_view_grants"."revoked_by_user_id" IS NULL OR "agent_context_view_grants"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_context_view_grants" ADD CONSTRAINT "agent_context_view_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_view_grants" ADD CONSTRAINT "agent_context_view_grants_grantee_agent_id_agents_id_fk" FOREIGN KEY ("grantee_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_view_grants" ADD CONSTRAINT "agent_context_view_grants_granter_user_id_users_id_fk" FOREIGN KEY ("granter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_context_view_grants" ADD CONSTRAINT "agent_context_view_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_context_view_grants_active" ON "agent_context_view_grants" USING btree ("server_id","grantee_agent_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "idx_agent_context_view_grants_grantee" ON "agent_context_view_grants" USING btree ("grantee_agent_id");