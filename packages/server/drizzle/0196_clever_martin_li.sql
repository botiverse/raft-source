ALTER TABLE "oauth_client_installs" ALTER COLUMN "installed_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "installed_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_installed_by_agent_id_agents_id_fk" FOREIGN KEY ("installed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD CONSTRAINT "oauth_client_share_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_actor_valid" CHECK (("oauth_client_installs"."installed_by_user_id" IS NOT NULL AND "oauth_client_installs"."installed_by_agent_id" IS NULL)
      OR ("oauth_client_installs"."installed_by_user_id" IS NULL AND "oauth_client_installs"."installed_by_agent_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "oauth_client_share_links" ADD CONSTRAINT "oauth_client_share_links_actor_valid" CHECK (("oauth_client_share_links"."created_by_user_id" IS NOT NULL AND "oauth_client_share_links"."created_by_agent_id" IS NULL)
      OR ("oauth_client_share_links"."created_by_user_id" IS NULL AND "oauth_client_share_links"."created_by_agent_id" IS NOT NULL));