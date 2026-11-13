ALTER TABLE "server_members" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "theme_decor" boolean DEFAULT true NOT NULL;