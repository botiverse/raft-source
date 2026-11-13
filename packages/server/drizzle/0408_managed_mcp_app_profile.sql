-- MCP Apps: App profile and provenance on managed_mcp_servers.
--
-- Replaces the official-registry provenance columns this migration used to add. Those never
-- shipped: the registry import was removed before release (see #wg-mcp, 2026-10-14).
--
-- Expand-only. Every column is nullable with no default, so each ADD COLUMN is metadata-only and
-- an older binary that writes this table during a rolling deploy is unaffected. The two CHECKs
-- scan the table once; managed_mcp_servers holds one row per configured MCP server, so the
-- validation is short.
--
-- source_kind NULL means a row older than this migration (or written by an older binary during
-- the deploy). Readers derive it: `template` when provider names a recommended app, else `url`.
-- The backfill below fills existing rows so most reads never take that branch.
ALTER TABLE "managed_mcp_servers" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "homepage_url" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "logo_storage_key" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "when_to_use" text;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "required_header_names" jsonb;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "auth_probe" jsonb;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "server_info" jsonb;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD COLUMN "last_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_source_kind_valid" CHECK ("managed_mcp_servers"."source_kind" IS NULL OR "managed_mcp_servers"."source_kind" IN ('url', 'template'));--> statement-breakpoint
ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_when_to_use_valid" CHECK ("managed_mcp_servers"."when_to_use" IS NULL OR (length("managed_mcp_servers"."when_to_use") <= 160 AND "managed_mcp_servers"."when_to_use" !~ '[\x00-\x1F\x7F]'));--> statement-breakpoint
UPDATE "managed_mcp_servers" SET "source_kind" = 'template', "template_key" = "provider" WHERE "provider" IN ('notion', 'linear');--> statement-breakpoint
UPDATE "managed_mcp_servers" SET "source_kind" = 'url' WHERE "provider" = 'custom';
