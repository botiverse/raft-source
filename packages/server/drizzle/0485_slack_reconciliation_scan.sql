SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD COLUMN "reconciliation_scan" jsonb;