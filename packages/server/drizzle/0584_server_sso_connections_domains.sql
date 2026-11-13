-- SSO v1 (rfcs/083-server-sso.md §4): a Server's connection to its company's
-- identity provider (one per Server, its sign-in rules on the same row) and
-- the email domains it proved by DNS TXT. Two new tables, nothing read or
-- written until `server_sso_v1` is on for a Server. The foreign keys take a
-- brief lock on `servers` and `users`; give up after 5 s rather than queue
-- traffic behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "server_sso_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"client_secret_ciphertext" text,
	"draft_config" jsonb,
	"draft_client_secret_ciphertext" text,
	"auto_join" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"session_max_age_days" integer DEFAULT 7 NOT NULL,
	"created_by_user_id" uuid,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_sso_connections_max_age" CHECK ("server_sso_connections"."session_max_age_days" BETWEEN 1 AND 30),
	CONSTRAINT "server_sso_connections_required_active" CHECK (NOT "server_sso_connections"."required" OR "server_sso_connections"."status" = 'active')
);
--> statement-breakpoint
CREATE TABLE "server_sso_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_result" text,
	"absent_since" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_sso_connections" ADD CONSTRAINT "server_sso_connections_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sso_connections" ADD CONSTRAINT "server_sso_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sso_domains" ADD CONSTRAINT "server_sso_domains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_sso_domains" ADD CONSTRAINT "server_sso_domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_sso_connections_server" ON "server_sso_connections" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_sso_domains_server_domain" ON "server_sso_domains" USING btree ("server_id","domain");--> statement-breakpoint
CREATE INDEX "idx_server_sso_domains_domain" ON "server_sso_domains" USING btree ("domain") WHERE "server_sso_domains"."verified_at" IS NOT NULL;