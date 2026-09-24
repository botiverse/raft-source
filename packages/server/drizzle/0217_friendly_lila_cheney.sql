CREATE TABLE "agent_provider_connections" (
	"server_id" uuid NOT NULL,
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"expected_config_version" integer NOT NULL,
	"expected_credential_version" integer NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connection_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider_id" text NOT NULL,
	"auth_method" text DEFAULT 'api_key' NOT NULL,
	"endpoint_url" text,
	"supports_image_input" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error_category" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_provider_connections" ADD CONSTRAINT "agent_provider_connections_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provider_connections" ADD CONSTRAINT "agent_provider_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provider_connections" ADD CONSTRAINT "agent_provider_connections_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_provider_connections" ADD CONSTRAINT "agent_provider_connections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_credentials" ADD CONSTRAINT "provider_connection_credentials_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_credentials" ADD CONSTRAINT "provider_connection_credentials_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_provider_connections_server" ON "agent_provider_connections" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_agent_provider_connections_connection" ON "agent_provider_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_connection_credentials_connection" ON "provider_connection_credentials" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_provider_connection_credentials_scope" ON "provider_connection_credentials" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_connections_server_name" ON "provider_connections" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX "idx_provider_connections_server" ON "provider_connections" USING btree ("server_id");--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'provider_connections_v0',
	'Reusable AI provider connections; initially limited to slock-android and botiverse servers',
	true,
	false,
	'server',
	false,
	NULL,
	'provider_connections_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" IN ('slock-android', 'botiverse')
		AND "deleted_at" IS NULL
)
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values",
	"percentage_basis_points",
	"variant"
)
SELECT
	'3ca7a0aa-c094-432d-a8a9-d040122d983f',
	'provider_connections_v0',
	'server',
	0,
	'allow',
	"server_ids",
	NULL,
	NULL
FROM allowlist
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"priority" = EXCLUDED."priority",
	"decision" = EXCLUDED."decision",
	"updated_at" = now();
