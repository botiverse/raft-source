-- Who builds and hosts a recommended MCP App's server, so the Apps page can say
-- "By Notion" (Raft Apps already expose publisherName). Nullable: App Admin's
-- template functions do not write it yet, and their rows read as null. Its
-- column grant is unchanged: App Admin reads listed columns only.
--
-- mcp_app_templates is a small, rarely written catalog: the CHECK validates
-- about twenty rows. Under a short lock timeout (the deploy retries).
-- The backfill names the publisher of each bundled template
-- (config/mcpAppTemplates.json) and leaves a value already set alone.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "mcp_app_templates" ADD COLUMN "publisher_name" text;--> statement-breakpoint
ALTER TABLE "mcp_app_templates" ADD CONSTRAINT "mcp_app_templates_publisher_name_valid" CHECK ("mcp_app_templates"."publisher_name" IS NULL OR length(btrim("mcp_app_templates"."publisher_name")) BETWEEN 1 AND 120);--> statement-breakpoint
UPDATE "mcp_app_templates" AS t
SET "publisher_name" = v.publisher_name
FROM (VALUES
  ('notion', 'Notion'),
  ('linear', 'Linear'),
  ('atlassian', 'Atlassian'),
  ('figma', 'Figma'),
  ('gmail', 'Google'),
  ('drive', 'Google'),
  ('calendar', 'Google'),
  ('sentry', 'Sentry'),
  ('airtable', 'Airtable'),
  ('monday', 'monday.com'),
  ('asana', 'Asana'),
  ('hubspot', 'HubSpot'),
  ('stripe', 'Stripe'),
  ('supabase', 'Supabase'),
  ('sheets', 'Google'),
  ('docs', 'Google'),
  ('slides', 'Google'),
  ('workiq', 'Microsoft'),
  ('canva', 'Canva'),
  ('perplexity', 'Perplexity')
) AS v(key, publisher_name)
WHERE t."key" = v.key AND t."publisher_name" IS NULL;
