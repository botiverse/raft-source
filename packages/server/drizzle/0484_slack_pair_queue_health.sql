SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_delivery_partitions" ADD COLUMN "authority_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_delivery_partitions" ADD COLUMN "authority_blocked_reason" text;--> statement-breakpoint
ALTER TABLE "external_delivery_partitions" ADD COLUMN "authority_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_delivery_partitions" ADD COLUMN "authority_overdue_alerted_at" timestamp with time zone;