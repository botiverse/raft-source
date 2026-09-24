ALTER TABLE "server_members" ADD COLUMN "pinned_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "server_switcher_order" json;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "server_order_version" integer DEFAULT 0 NOT NULL;