-- MCP Apps: which Connection each Agent uses.
--
-- connection_mode 'default' follows the App's server default; 'pinned' uses bound_connection_id.
-- "Off" is enabled = false, the column older binaries already honour, so it needs no new value.
-- Every existing row becomes 'default' through the column default (no UPDATE): an enabled row keeps
-- using the App's single credential, which 0409 made its default, and a disabled row stays off.
-- An older binary that updates enabled / allowed_tools during the deploy never touches these columns.
--
-- A pinned row whose Connection is deleted keeps connection_mode = 'pinned' with a NULL binding
-- (FK SET NULL) and is denied, never sent to the default.
ALTER TABLE "managed_mcp_assignments" ADD COLUMN "connection_mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD COLUMN "bound_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_bound_connection_id_managed_mcp_credentials_id_fk" FOREIGN KEY ("bound_connection_id") REFERENCES "public"."managed_mcp_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_mcp_assignments" ADD CONSTRAINT "managed_mcp_assignments_binding_matches_mode" CHECK ("managed_mcp_assignments"."connection_mode" = 'pinned' OR "managed_mcp_assignments"."bound_connection_id" IS NULL);
