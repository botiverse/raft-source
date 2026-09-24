CREATE TABLE "agent_bootstrap_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_lookup_hash" "bytea" NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_credential_id" uuid,
	"consumed_ip" text,
	"consumed_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_bootstrap_tokens_token_lookup_hash_unique" UNIQUE("token_lookup_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"name" text,
	"scopes" text[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"last_used_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "computers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"attached_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"last_used_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_bootstrap_tokens" ADD CONSTRAINT "agent_bootstrap_tokens_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_attached_by_user_id_users_id_fk" FOREIGN KEY ("attached_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_bootstrap_tokens_agent" ON "agent_bootstrap_tokens" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_bootstrap_tokens_server" ON "agent_bootstrap_tokens" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_credentials_prefix" ON "agent_credentials" USING btree ("api_key_prefix");--> statement-breakpoint
CREATE INDEX "idx_agent_credentials_agent" ON "agent_credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_computers_prefix" ON "computers" USING btree ("api_key_prefix");--> statement-breakpoint
CREATE INDEX "idx_computers_server" ON "computers" USING btree ("server_id");