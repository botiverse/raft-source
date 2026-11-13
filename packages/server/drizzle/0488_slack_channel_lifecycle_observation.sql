-- Metadata-only columns and a widened receipt CHECK. Existing rows satisfy the
-- previous stricter CHECK; NOT VALID avoids rescanning them under the DDL lock
-- while PostgreSQL still enforces the expanded rule on every new/updated row.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" DROP CONSTRAINT "external_ingress_discard_coordinates_valid";--> statement-breakpoint
ALTER TABLE "external_addressability_projections" ADD COLUMN "slack_member_event_clock" text;--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD COLUMN "slack_lifecycle_retry_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD COLUMN "slack_lifecycle_observation" jsonb;--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" ADD CONSTRAINT "external_ingress_discard_coordinates_valid" CHECK (length(btrim("external_ingress_discard_receipts"."provider")) > 0
      AND length("external_ingress_discard_receipts"."provider") <= 80
      AND "external_ingress_discard_receipts"."provider" = 'slack'
      AND "external_ingress_discard_receipts"."environment" IN ('test', 'production')
      AND "external_ingress_discard_receipts"."endpoint_revision" > 0
      AND "external_ingress_discard_receipts"."signing_secret_revision" > 0
      AND length(btrim("external_ingress_discard_receipts"."provider_authority_id")) > 0
      AND length("external_ingress_discard_receipts"."provider_authority_id") <= 160
      AND ("external_ingress_discard_receipts"."provider_conversation_id" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."provider_conversation_id")) > 0
        AND length("external_ingress_discard_receipts"."provider_conversation_id") <= 160
      ))
      AND length(btrim("external_ingress_discard_receipts"."provider_event_id")) > 0
      AND length("external_ingress_discard_receipts"."provider_event_id") <= 320
      AND length(btrim("external_ingress_discard_receipts"."outcome_reason")) > 0
      AND length("external_ingress_discard_receipts"."outcome_reason") <= 160
      AND "external_ingress_discard_receipts"."outcome_reason" IN (
        'unsupported_event',
        'lifecycle_metadata_processed',
        'lifecycle_metadata_stale_authority',
        'lifecycle_metadata_unpaired',
        'provider_tokens_unrelated',
        'provider_loop_suppressed',
        'unsupported_message_subtype',
        'capability_disabled'
      )
      AND ("external_ingress_discard_receipts"."slack_retry_num" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_num")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_num") <= 32
      ))
      AND ("external_ingress_discard_receipts"."slack_retry_reason" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_reason")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_reason") <= 160
      ))
      AND "external_ingress_discard_receipts"."payload_digest" ~ '^[0-9a-f]{64}$') NOT VALID;