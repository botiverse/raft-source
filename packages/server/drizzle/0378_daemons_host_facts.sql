ALTER TABLE "daemons" ADD COLUMN "host_provider" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "os_release" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "os_id" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "os_id_like" json;