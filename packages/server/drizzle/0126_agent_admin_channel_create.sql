ALTER TABLE "server_agent_members" DROP CONSTRAINT IF EXISTS "server_agent_members_role_check";--> statement-breakpoint
ALTER TABLE "server_agent_members" ADD CONSTRAINT "server_agent_members_role_check" CHECK ("role" IN ('member', 'admin'));
