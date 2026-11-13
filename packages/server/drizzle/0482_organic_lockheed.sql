ALTER TABLE "external_attachment_transfer_jobs" DROP CONSTRAINT "external_attachment_transfer_coordinates";--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" DROP CONSTRAINT "external_attachment_transfer_snapshot";--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_coordinates" CHECK (("external_attachment_transfer_jobs"."direction" = 'provider_inbound'
        AND "external_attachment_transfer_jobs"."asset_id" IS NOT NULL AND "external_attachment_transfer_jobs"."message_fact_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."outbound_delivery_id" IS NULL AND "external_attachment_transfer_jobs"."source_attachment_id" IS NULL)
      OR ("external_attachment_transfer_jobs"."direction" = 'raft_outbound'
        AND "external_attachment_transfer_jobs"."message_fact_id" IS NULL
        AND "external_attachment_transfer_jobs"."outbound_delivery_id" IS NOT NULL AND "external_attachment_transfer_jobs"."source_attachment_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_object_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_origin_server_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_storage_key" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_filename" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_mime_type" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" IS NOT NULL
        AND ("external_attachment_transfer_jobs"."frozen_content_digest" IS NOT NULL OR "external_attachment_transfer_jobs"."phase" = 'ticket')));--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_snapshot" CHECK (("external_attachment_transfer_jobs"."direction" = 'provider_inbound'
        AND "external_attachment_transfer_jobs"."frozen_object_id" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_origin_server_id" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_storage_key" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_filename" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_mime_type" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_content_digest" IS NULL)
      OR ("external_attachment_transfer_jobs"."direction" = 'raft_outbound'
        AND length(btrim("external_attachment_transfer_jobs"."frozen_storage_key")) > 0 AND length("external_attachment_transfer_jobs"."frozen_storage_key") <= 1024
        AND length(btrim("external_attachment_transfer_jobs"."frozen_filename")) > 0 AND length("external_attachment_transfer_jobs"."frozen_filename") <= 1024
        AND length(btrim("external_attachment_transfer_jobs"."frozen_mime_type")) > 0 AND length("external_attachment_transfer_jobs"."frozen_mime_type") <= 255
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" > 0
        AND ("external_attachment_transfer_jobs"."frozen_content_digest" IS NULL OR "external_attachment_transfer_jobs"."frozen_content_digest" ~ '^[0-9a-f]{64}$')));