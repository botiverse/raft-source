-- Recommended MCP App templates: their logos (web static /app-logos). Only rows
-- whose logo is still unset: a logo an admin set stays.
UPDATE "mcp_app_templates" SET "logo_url" = 'https://app.raft.build/app-logos/notion.svg' WHERE "key" = 'notion' AND "logo_url" IS NULL;--> statement-breakpoint
UPDATE "mcp_app_templates" SET "logo_url" = 'https://app.raft.build/app-logos/linear.svg' WHERE "key" = 'linear' AND "logo_url" IS NULL;
