CREATE TABLE "mcp_app_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"homepage_url" text NOT NULL,
	"logo_url" text,
	"category" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"auth_kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_app_templates_key_unique" UNIQUE("key"),
	CONSTRAINT "mcp_app_templates_status_valid" CHECK ("mcp_app_templates"."status" IN ('active', 'retired')),
	CONSTRAINT "mcp_app_templates_auth_kind_valid" CHECK ("mcp_app_templates"."auth_kind" IN ('none', 'headers', 'oauth')),
	CONSTRAINT "mcp_app_templates_revision_positive" CHECK ("mcp_app_templates"."revision" > 0),
	CONSTRAINT "mcp_app_templates_key_valid" CHECK ("mcp_app_templates"."key" ~ '^[a-z][a-z0-9-]{0,62}$'),
	CONSTRAINT "mcp_app_templates_name_valid" CHECK (length(btrim("mcp_app_templates"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "mcp_app_templates_description_valid" CHECK (length(btrim("mcp_app_templates"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "mcp_app_templates_homepage_https" CHECK ("mcp_app_templates"."homepage_url" ~ '^https://'),
	CONSTRAINT "mcp_app_templates_endpoint_https" CHECK ("mcp_app_templates"."endpoint_url" ~ '^https://'),
	CONSTRAINT "mcp_app_templates_logo_https_or_null" CHECK ("mcp_app_templates"."logo_url" IS NULL OR "mcp_app_templates"."logo_url" ~ '^https://')
);
--> statement-breakpoint
ALTER TABLE "mcp_app_templates" ADD CONSTRAINT "mcp_app_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_app_templates" ADD CONSTRAINT "mcp_app_templates_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_app_templates_status" ON "mcp_app_templates" USING btree ("status");
--> statement-breakpoint
-- Seed the catalog from the bundled templates (the DB becomes the source; the JSON stays the
-- offline fallback in src/config). ids are generated here: the schema's $defaultFn is app-level,
-- not a DB default, so a raw INSERT must supply one. ON CONFLICT keeps a re-run idempotent.
INSERT INTO "mcp_app_templates" ("id", "key", "name", "description", "homepage_url", "logo_url", "category", "endpoint_url", "auth_kind", "status")
VALUES
  (gen_random_uuid(), 'notion', 'Notion', 'Search and update the Notion workspace you authorize.', 'https://www.notion.so', NULL, 'Productivity & Collaboration', 'https://mcp.notion.com/mcp', 'oauth', 'active'),
  (gen_random_uuid(), 'linear', 'Linear', 'Find, create, and update Linear issues, projects, and comments.', 'https://linear.app', NULL, 'Productivity & Collaboration', 'https://mcp.linear.app/mcp', 'oauth', 'active')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
