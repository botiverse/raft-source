ALTER TABLE "external_inbound_events" DROP CONSTRAINT "external_inbound_event_coordinates_valid";--> statement-breakpoint
ALTER TABLE "external_inbound_events" ADD CONSTRAINT "external_inbound_event_coordinates_valid" CHECK (length(btrim("external_inbound_events"."provider")) > 0
      AND length(btrim("external_inbound_events"."app_registration_id")) > 0
      AND length(btrim("external_inbound_events"."install_id")) > 0
      AND length(btrim("external_inbound_events"."workspace_id")) > 0
      AND length(btrim("external_inbound_events"."provider_authority_id")) > 0
      AND length(btrim("external_inbound_events"."provider_conversation_id")) > 0
      AND length(btrim("external_inbound_events"."provider_event_id")) > 0
      AND length(btrim("external_inbound_events"."binding_id")) > 0
      AND length(btrim("external_inbound_events"."runtime_revision")) > 0
      AND length("external_inbound_events"."provider") <= 80
      AND length("external_inbound_events"."app_registration_id") <= 320
      AND length("external_inbound_events"."install_id") <= 160
      AND length("external_inbound_events"."workspace_id") <= 320
      AND length("external_inbound_events"."provider_authority_id") <= 160
      AND length("external_inbound_events"."provider_conversation_id") <= 160
      AND length("external_inbound_events"."provider_event_id") <= 320
      AND length("external_inbound_events"."binding_id") <= 160
      AND length("external_inbound_events"."runtime_revision") <= 320
      AND "external_inbound_events"."binding_epoch" > 0 AND "external_inbound_events"."connection_epoch" > 0
      AND "external_inbound_events"."privacy_class" IN ('public', 'private')
      AND "external_inbound_events"."environment" IN ('test', 'production')
      AND "external_inbound_events"."normalized_payload_digest" ~ '^[0-9a-f]{64}$'
      AND "external_inbound_events"."payload_aad_purpose" = 'external-inbound-normalized-event'
      AND "external_inbound_events"."payload_aad_version" = 1 AND "external_inbound_events"."payload_schema_version" IN (1, 2));