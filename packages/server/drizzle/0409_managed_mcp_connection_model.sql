-- MCP Apps: Connections.
--
-- A managed_mcp_credentials row is an MCP App Connection. An App can now have several; each Agent
-- uses the App's server default unless it is granted a specific Connection (0410).
--
-- Rolling deploy (expand-only except for the one index drop below):
--   * is_server_default DEFAULT true fills every existing row, so each existing credential becomes
--     its App's default with no UPDATE and behaviour is unchanged. A row an older binary inserts
--     during the deploy gets the same meaning it has today. New code always writes it explicitly.
--   * DROP INDEX idx_managed_mcp_credentials_server removes the one-credential-per-App rule
--     (decided in #wg-mcp, 2026-10-14). An older binary saves credentials with
--     ON CONFLICT (mcp_server_id), which has no arbiter once the index is gone, so a credential save
--     made through an older binary during the deploy window fails and can be retried. Existing
--     credentials and Agent calls are not affected. Accepted: these writes are rare.
--   * The default index is built after the drop; existing rows are one per App, so it cannot
--     conflict.
DROP INDEX "idx_managed_mcp_credentials_server";--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "is_server_default" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "auth_kind" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "auth_status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD COLUMN "intent" jsonb;--> statement-breakpoint
ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_oauth_attempts" ADD CONSTRAINT "managed_mcp_oauth_attempts_connection_id_managed_mcp_credentials_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."managed_mcp_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_managed_mcp_credentials_default" ON "managed_mcp_credentials" USING btree ("mcp_server_id") WHERE "managed_mcp_credentials"."is_server_default";--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_credentials_mcp_server" ON "managed_mcp_credentials" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "idx_managed_mcp_oauth_attempts_connection" ON "managed_mcp_oauth_attempts" USING btree ("connection_id");
--> statement-breakpoint
-- Connection status from the App row, so the new readers never see a wrong "ready".
UPDATE "managed_mcp_credentials" AS c SET
  "auth_kind" = CASE s."auth_mode" WHEN 'oauth' THEN 'oauth' WHEN 'headers' THEN 'headers' END,
  "auth_status" = CASE
    WHEN s."auth_mode" <> 'oauth' THEN 'ready'
    WHEN s."oauth_status" = 'connected' THEN 'ready'
    WHEN s."oauth_status" = 'pending' THEN 'pending'
    WHEN s."oauth_status" = 'error' THEN 'expired'
    ELSE 'needs_auth'
  END,
  "name" = s."name"
FROM "managed_mcp_servers" AS s
WHERE s."id" = c."mcp_server_id";
