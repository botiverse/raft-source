-- Private bindings no longer require a per-member OAuth link snapshot.
-- audience_revision / audience_fresh_until become optional refresh metadata
-- for both privacy classes; the privacy mirror check stays intact.
ALTER TABLE "external_channel_bindings" DROP CONSTRAINT "external_channel_binding_privacy_valid";--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_binding_privacy_valid" CHECK (("external_channel_bindings"."privacy_class" = 'public' AND "external_channel_bindings"."provider_conversation_kind" = 'public_channel')
      OR ("external_channel_bindings"."privacy_class" = 'private' AND "external_channel_bindings"."provider_conversation_kind" = 'private_channel'));