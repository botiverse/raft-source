ALTER TABLE "server_members" ADD COLUMN "sidebar_dm_order" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "pinned_channel_ids" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "pinned_agent_ids" json;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "pinned_order" json;