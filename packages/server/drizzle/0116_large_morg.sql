CREATE TABLE "server_agent_members" (
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_agent_members_server_id_agent_id_pk" PRIMARY KEY("server_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "server_agent_members" ADD CONSTRAINT "server_agent_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_agent_members" ADD CONSTRAINT "server_agent_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_server_agent_members_agent" ON "server_agent_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_server_agent_members_server_role" ON "server_agent_members" USING btree ("server_id","role");--> statement-breakpoint
ALTER TABLE "server_agent_members" ADD CONSTRAINT "server_agent_members_role_check" CHECK ("role" IN ('member'));
