CREATE TABLE "managed_mcp_assignments" (
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_tools" jsonb,
	"assignment_version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_mcp_assignments_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "managed_mcp_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"encrypted_headers" text,
	"encrypted_oauth" text,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_mcp_oauth_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"state_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider" text DEFAULT 'custom' NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"oauth_status" text DEFAULT 'disconnected' NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"endpoint_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"catalog_version" integer DEFAULT 0 NOT NULL,
	"tool_catalog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_mcp_server_id_managed_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."managed_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_mcp_server_id_managed_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."managed_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD CONSTRAINT "managed_mcp_oauth_attempts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD CONSTRAINT "managed_mcp_oauth_attempts_mcp_server_id_managed_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."managed_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD CONSTRAINT "managed_mcp_oauth_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_assignments_server_agent" ON "managed_mcp_assignments" USING btree ("server_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_assignments_mcp_server" ON "managed_mcp_assignments" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_mcp_credentials_server" ON "managed_mcp_credentials" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_credentials_scope" ON "managed_mcp_credentials" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_mcp_oauth_attempts_state" ON "managed_mcp_oauth_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_oauth_attempts_expiry" ON "managed_mcp_oauth_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_oauth_attempts_server" ON "managed_mcp_oauth_attempts" USING btree ("server_id","mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_mcp_servers_server_name" ON "managed_mcp_servers" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_servers_server" ON "managed_mcp_servers" USING btree ("server_id");