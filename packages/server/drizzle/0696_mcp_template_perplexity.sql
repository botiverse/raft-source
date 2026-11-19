-- Add Perplexity to the admin-owned MCP App template catalog.
-- Existing rows win: an administrator's own "perplexity" row (edited, retired or
-- with another endpoint) is left as it is. Data only: one INSERT into the small,
-- non-hot catalog table; the snapshot is unchanged.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
INSERT INTO "mcp_app_templates" ("id", "key", "name", "description", "homepage_url", "logo_url", "category", "endpoint_url", "auth_kind", "status", "created_at")
VALUES
  (gen_random_uuid(), 'perplexity', 'Perplexity', 'Web search and cited answers from Perplexity, using the Perplexity account you sign in with.', 'https://www.perplexity.ai', 'https://app.raft.build/app-logos/perplexity.png', 'Productivity & Collaboration', 'https://api.perplexity.ai/mcp', 'oauth', 'active', statement_timestamp())
ON CONFLICT ("key") DO NOTHING;
