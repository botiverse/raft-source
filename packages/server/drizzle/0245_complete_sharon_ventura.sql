ALTER TABLE "server_members" ADD COLUMN "sidebar_custom_sections" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "sidebar_section_order" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "sidebar_section_placements" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "sidebar_sections_version" integer DEFAULT 0 NOT NULL;