CREATE TABLE "external_actor_projections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"external_actor_id" text NOT NULL,
	"display_name" text NOT NULL,
	"handles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"deactivated" boolean DEFAULT false NOT NULL,
	"projection_revision" integer NOT NULL,
	"avatar_artifact_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_actor_projection_revision_positive" CHECK ("external_actor_projections"."projection_revision" > 0),
	CONSTRAINT "external_actor_projection_values_valid" CHECK (length(btrim("external_actor_projections"."provider")) > 0
      AND length(btrim("external_actor_projections"."app_registration_id")) > 0
      AND length(btrim("external_actor_projections"."install_id")) > 0
      AND length(btrim("external_actor_projections"."workspace_id")) > 0
      AND length(btrim("external_actor_projections"."external_actor_id")) > 0
      AND length(btrim("external_actor_projections"."display_name")) > 0
      AND "external_actor_projections"."actor_kind" IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND "external_actor_projections"."state" IN ('active', 'tombstoned'))
);
--> statement-breakpoint
CREATE TABLE "external_addressability_projections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"projection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"member_revision" integer NOT NULL,
	"context_revision" integer NOT NULL,
	"state" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_addressability_revisions_positive" CHECK ("external_addressability_projections"."connection_epoch" > 0 AND "external_addressability_projections"."binding_epoch" > 0
      AND "external_addressability_projections"."member_revision" > 0 AND "external_addressability_projections"."context_revision" > 0),
	CONSTRAINT "external_addressability_values_valid" CHECK (length(btrim("external_addressability_projections"."provider")) > 0
      AND length(btrim("external_addressability_projections"."app_registration_id")) > 0
      AND length(btrim("external_addressability_projections"."install_id")) > 0
      AND length(btrim("external_addressability_projections"."workspace_id")) > 0
      AND length(btrim("external_addressability_projections"."binding_id")) > 0
      AND length(btrim("external_addressability_projections"."conversation_id")) > 0
      AND "external_addressability_projections"."state" IN ('active', 'removed', 'stale', 'revoked', 'quarantined')
      AND "external_addressability_projections"."expires_at" > "external_addressability_projections"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "external_app_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"encrypted_material" text NOT NULL,
	"envelope_key_id" text NOT NULL,
	"aad_version" integer DEFAULT 1 NOT NULL,
	"credential_revision" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_credential_state_valid" CHECK ("external_app_credentials"."state" IN ('active', 'persist_unknown', 'revoked')),
	CONSTRAINT "external_app_credential_revision_positive" CHECK ("external_app_credentials"."credential_revision" > 0 AND "external_app_credentials"."aad_version" > 0),
	CONSTRAINT "external_app_credential_revocation_valid" CHECK (("external_app_credentials"."state" = 'revoked' AND "external_app_credentials"."revoked_at" IS NOT NULL)
      OR ("external_app_credentials"."state" <> 'revoked' AND "external_app_credentials"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_app_ingress_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"exact_request_url" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"endpoint_revision" integer DEFAULT 1 NOT NULL,
	"signing_secret_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_ingress_endpoint_environment_valid" CHECK ("external_app_ingress_endpoints"."environment" IN ('test', 'production')),
	CONSTRAINT "external_app_ingress_endpoint_state_valid" CHECK ("external_app_ingress_endpoints"."state" IN ('active', 'disabled')),
	CONSTRAINT "external_app_ingress_endpoint_revisions_positive" CHECK ("external_app_ingress_endpoints"."endpoint_revision" > 0 AND "external_app_ingress_endpoints"."signing_secret_revision" > 0),
	CONSTRAINT "external_app_ingress_endpoint_url_present" CHECK (length(btrim("external_app_ingress_endpoints"."exact_request_url")) > 0)
);
--> statement-breakpoint
CREATE TABLE "external_app_install_grant_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"receipt_revision" integer NOT NULL,
	"connection_epoch" integer NOT NULL,
	"scope_revision" integer NOT NULL,
	"credential_revision" integer NOT NULL,
	"provider_app_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"provider_bot_id" text NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_hash" text NOT NULL,
	"observation_source" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_install_grant_receipt_revisions_positive" CHECK ("external_app_install_grant_receipts"."receipt_revision" > 0 AND "external_app_install_grant_receipts"."connection_epoch" > 0
      AND "external_app_install_grant_receipts"."scope_revision" > 0 AND "external_app_install_grant_receipts"."credential_revision" > 0),
	CONSTRAINT "external_app_install_grant_receipt_values_present" CHECK (length(btrim("external_app_install_grant_receipts"."provider_app_id")) > 0
      AND length(btrim("external_app_install_grant_receipts"."provider_authority_id")) > 0
      AND length(btrim("external_app_install_grant_receipts"."bot_user_id")) > 0
      AND length(btrim("external_app_install_grant_receipts"."provider_bot_id")) > 0
      AND "external_app_install_grant_receipts"."grant_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_app_install_grant_receipt_status_valid" CHECK ("external_app_install_grant_receipts"."status" IN ('valid', 'mismatch', 'unreadable')),
	CONSTRAINT "external_app_install_grant_receipt_error_valid" CHECK (("external_app_install_grant_receipts"."status" = 'valid' AND "external_app_install_grant_receipts"."error_code" IS NULL)
      OR ("external_app_install_grant_receipts"."status" <> 'valid' AND "external_app_install_grant_receipts"."error_code" IS NOT NULL)),
	CONSTRAINT "external_app_install_grant_receipt_window_valid" CHECK ("external_app_install_grant_receipts"."expires_at" > "external_app_install_grant_receipts"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "external_app_installs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"server_grant_id" uuid NOT NULL,
	"grant_epoch" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_reason" text,
	"connection_epoch" integer DEFAULT 1 NOT NULL,
	"scope_revision" integer DEFAULT 1 NOT NULL,
	"credential_revision" integer DEFAULT 1 NOT NULL,
	"installed_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_app_id" text NOT NULL,
	"provider_team_id" text,
	"provider_enterprise_id" text,
	"authority_type" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"bot_user_id" text,
	"provider_bot_id" text,
	"workspace_name" text,
	"last_verified_at" timestamp with time zone,
	"install_grant_renewal_lease_owner" text,
	"install_grant_renewal_lease_expires_at" timestamp with time zone,
	"install_grant_renewal_next_attempt_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_install_state_valid" CHECK ("external_app_installs"."state" IN ('pending', 'active', 'reauth_required', 'disconnected', 'revoked', 'quarantined')),
	CONSTRAINT "external_app_install_authority_type_valid" CHECK ("external_app_installs"."authority_type" IN ('team', 'enterprise')),
	CONSTRAINT "external_app_install_epochs_positive" CHECK ("external_app_installs"."grant_epoch" > 0 AND "external_app_installs"."connection_epoch" > 0 AND "external_app_installs"."scope_revision" > 0 AND "external_app_installs"."credential_revision" > 0),
	CONSTRAINT "external_app_install_m0_team_only" CHECK ("external_app_installs"."authority_type" = 'team' AND "external_app_installs"."provider_team_id" IS NOT NULL
      AND "external_app_installs"."provider_enterprise_id" IS NULL AND "external_app_installs"."provider_authority_id" = "external_app_installs"."provider_team_id"),
	CONSTRAINT "external_app_install_state_reason_valid" CHECK (("external_app_installs"."state" IN ('pending', 'active') AND "external_app_installs"."state_reason" IS NULL)
      OR ("external_app_installs"."state" NOT IN ('pending', 'active') AND "external_app_installs"."state_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_app_manifest_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_id" uuid NOT NULL,
	"receipt_revision" integer NOT NULL,
	"manager_credential_revision" integer NOT NULL,
	"provider_app_id" text NOT NULL,
	"normalized_manifest_hash" text NOT NULL,
	"normalized_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalized_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"normalized_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_manifest_receipt_status_valid" CHECK ("external_app_manifest_receipts"."status" IN ('valid', 'mismatch', 'unreadable')),
	CONSTRAINT "external_app_manifest_receipt_revision_positive" CHECK ("external_app_manifest_receipts"."receipt_revision" > 0 AND "external_app_manifest_receipts"."manager_credential_revision" > 0),
	CONSTRAINT "external_app_manifest_receipt_window_valid" CHECK ("external_app_manifest_receipts"."expires_at" > "external_app_manifest_receipts"."observed_at"),
	CONSTRAINT "external_app_manifest_receipt_error_valid" CHECK (("external_app_manifest_receipts"."status" = 'valid' AND "external_app_manifest_receipts"."error_code" IS NULL)
      OR ("external_app_manifest_receipts"."status" <> 'valid' AND "external_app_manifest_receipts"."error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_app_registration_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"encrypted_secret_ref" text NOT NULL,
	"envelope_key_id" text NOT NULL,
	"aad_version" integer DEFAULT 1 NOT NULL,
	"secret_revision" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_registration_secret_purpose_valid" CHECK ("external_app_registration_secrets"."purpose" IN ('signing_secret', 'manifest_manager', 'oauth_client_secret')),
	CONSTRAINT "external_app_registration_secret_revision_positive" CHECK ("external_app_registration_secrets"."secret_revision" > 0 AND "external_app_registration_secrets"."aad_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "external_app_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"provider_app_id" text NOT NULL,
	"provider_oauth_client_id" text NOT NULL,
	"capability_manifest_version" integer NOT NULL,
	"capability_manifest_hash" text NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_registration_provider_valid" CHECK ("external_app_registrations"."provider" = 'slack'),
	CONSTRAINT "external_app_registration_environment_valid" CHECK ("external_app_registrations"."environment" IN ('test', 'production')),
	CONSTRAINT "external_app_registration_state_valid" CHECK ("external_app_registrations"."state" IN ('active', 'disabled')),
	CONSTRAINT "external_app_registration_manifest_version_positive" CHECK ("external_app_registrations"."capability_manifest_version" > 0),
	CONSTRAINT "external_app_registration_manifest_hash_present" CHECK (length(btrim("external_app_registrations"."capability_manifest_hash")) > 0)
);
--> statement-breakpoint
CREATE TABLE "external_app_server_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"grant_epoch" integer DEFAULT 1 NOT NULL,
	"granted_manifest_version" integer NOT NULL,
	"granted_manifest_hash" text NOT NULL,
	"granted_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_by_type" text NOT NULL,
	"granted_by_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_app_server_grant_state_valid" CHECK ("external_app_server_grants"."state" IN ('active', 'revoked')),
	CONSTRAINT "external_app_server_grant_actor_type_valid" CHECK ("external_app_server_grants"."granted_by_type" IN ('human', 'agent')),
	CONSTRAINT "external_app_server_grant_epoch_positive" CHECK ("external_app_server_grants"."grant_epoch" > 0),
	CONSTRAINT "external_app_server_grant_revocation_valid" CHECK (("external_app_server_grants"."state" = 'active' AND "external_app_server_grants"."revoked_at" IS NULL AND "external_app_server_grants"."revoke_reason" IS NULL)
      OR ("external_app_server_grants"."state" = 'revoked' AND "external_app_server_grants"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_author_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_artifact_id" uuid,
	"fallback_kind" text NOT NULL,
	"consent_revision" integer NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_author_policy_values_valid" CHECK (length(btrim("external_author_policies"."provider")) > 0
      AND length(btrim("external_author_policies"."app_registration_id")) > 0
      AND length(btrim("external_author_policies"."install_id")) > 0
      AND length(btrim("external_author_policies"."binding_id")) > 0
      AND length(btrim("external_author_policies"."author_id")) > 0
      AND length(btrim("external_author_policies"."display_name")) > 0
      AND "external_author_policies"."binding_epoch" > 0 AND "external_author_policies"."consent_revision" > 0
      AND "external_author_policies"."author_type" IN ('user', 'agent')
      AND "external_author_policies"."fallback_kind" IN ('human', 'agent')
      AND "external_author_policies"."state" IN ('granted', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "external_binding_audience_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_epoch" integer NOT NULL,
	"audience_revision" integer NOT NULL,
	"external_member_count" integer NOT NULL,
	"external_audience_digest" text NOT NULL,
	"raft_member_count" integer NOT NULL,
	"raft_audience_digest" text NOT NULL,
	"status" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_binding_audience_status_valid" CHECK ("external_binding_audience_snapshots"."status" IN ('matched', 'mismatch', 'unavailable')),
	CONSTRAINT "external_binding_audience_revision_positive" CHECK ("external_binding_audience_snapshots"."binding_epoch" > 0 AND "external_binding_audience_snapshots"."audience_revision" > 0),
	CONSTRAINT "external_binding_audience_counts_nonnegative" CHECK ("external_binding_audience_snapshots"."external_member_count" >= 0 AND "external_binding_audience_snapshots"."raft_member_count" >= 0),
	CONSTRAINT "external_binding_audience_window_valid" CHECK ("external_binding_audience_snapshots"."expires_at" > "external_binding_audience_snapshots"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "external_channel_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_conversation_kind" text NOT NULL,
	"privacy_class" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"state_reason" text,
	"grant_epoch" integer NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_epoch" integer DEFAULT 1 NOT NULL,
	"audience_revision" integer,
	"audience_fresh_until" timestamp with time zone,
	"consented_by_type" text NOT NULL,
	"consented_by_id" uuid NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_channel_binding_state_valid" CHECK ("external_channel_bindings"."state" IN ('active', 'paused', 'revoked', 'quarantined')),
	CONSTRAINT "external_channel_binding_privacy_class_valid" CHECK ("external_channel_bindings"."privacy_class" IN ('public', 'private')),
	CONSTRAINT "external_channel_binding_conversation_kind_valid" CHECK ("external_channel_bindings"."provider_conversation_kind" IN ('public_channel', 'private_channel')),
	CONSTRAINT "external_channel_binding_consent_type_valid" CHECK ("external_channel_bindings"."consented_by_type" IN ('human', 'agent')),
	CONSTRAINT "external_channel_binding_epochs_positive" CHECK ("external_channel_bindings"."grant_epoch" > 0 AND "external_channel_bindings"."connection_epoch" > 0 AND "external_channel_bindings"."binding_epoch" > 0),
	CONSTRAINT "external_channel_binding_privacy_valid" CHECK (("external_channel_bindings"."privacy_class" = 'public' AND "external_channel_bindings"."provider_conversation_kind" = 'public_channel'
      AND "external_channel_bindings"."audience_revision" IS NULL AND "external_channel_bindings"."audience_fresh_until" IS NULL)
      OR ("external_channel_bindings"."privacy_class" = 'private' AND "external_channel_bindings"."provider_conversation_kind" = 'private_channel'
      AND "external_channel_bindings"."audience_revision" IS NOT NULL AND "external_channel_bindings"."audience_revision" > 0
      AND "external_channel_bindings"."audience_fresh_until" IS NOT NULL)),
	CONSTRAINT "external_channel_binding_consent_valid" CHECK ("external_channel_bindings"."consented_at" IS NOT NULL),
	CONSTRAINT "external_channel_binding_state_reason_valid" CHECK (("external_channel_bindings"."state" = 'active' AND "external_channel_bindings"."state_reason" IS NULL)
      OR ("external_channel_bindings"."state" <> 'active' AND "external_channel_bindings"."state_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_generation" bigint NOT NULL,
	"runtime_revision" text NOT NULL,
	"credential_revision" integer NOT NULL,
	"dispatch_authorization" text NOT NULL,
	"operator_decision_id" uuid,
	"operator_decision_action" text,
	"provider_io_started_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'provider_io_started' NOT NULL,
	"outcome_reason" text,
	"retry_after_ms" integer,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_delivery_attempt_coordinates_valid" CHECK ("external_delivery_attempts"."attempt_number" > 0
      AND "external_delivery_attempts"."lease_generation" > 0
      AND "external_delivery_attempts"."credential_revision" > 0
      AND length(btrim("external_delivery_attempts"."runtime_revision")) > 0
      AND length("external_delivery_attempts"."runtime_revision") <= 160),
	CONSTRAINT "external_delivery_attempt_authorization_valid" CHECK (("external_delivery_attempts"."dispatch_authorization" = 'automatic'
        AND "external_delivery_attempts"."operator_decision_id" IS NULL
        AND "external_delivery_attempts"."operator_decision_action" IS NULL)
      OR ("external_delivery_attempts"."dispatch_authorization" = 'audited_retry_in_place'
        AND "external_delivery_attempts"."operator_decision_id" IS NOT NULL
        AND "external_delivery_attempts"."operator_decision_action" = 'retry_in_place')),
	CONSTRAINT "external_delivery_attempt_closed_values" CHECK ("external_delivery_attempts"."dispatch_authorization" IN ('automatic', 'audited_retry_in_place')
      AND "external_delivery_attempts"."outcome" IN (
        'provider_io_started', 'accepted', 'rate_limited', 'transient_failure',
        'deterministic_failure', 'outcome_unknown'
      )),
	CONSTRAINT "external_delivery_attempt_outcome_shape" CHECK (("external_delivery_attempts"."outcome" = 'provider_io_started'
        AND "external_delivery_attempts"."terminal_at" IS NULL
        AND "external_delivery_attempts"."outcome_reason" IS NULL
        AND "external_delivery_attempts"."retry_after_ms" IS NULL)
      OR ("external_delivery_attempts"."outcome" <> 'provider_io_started'
        AND "external_delivery_attempts"."terminal_at" IS NOT NULL
        AND "external_delivery_attempts"."outcome_reason" IS NOT NULL
        AND length(btrim("external_delivery_attempts"."outcome_reason")) > 0
        AND length("external_delivery_attempts"."outcome_reason") <= 160
        AND (("external_delivery_attempts"."outcome" = 'rate_limited'
            AND "external_delivery_attempts"."retry_after_ms" IS NOT NULL
            AND "external_delivery_attempts"."retry_after_ms" >= 0)
          OR ("external_delivery_attempts"."outcome" <> 'rate_limited' AND "external_delivery_attempts"."retry_after_ms" IS NULL))))
);
--> statement-breakpoint
CREATE TABLE "external_delivery_operator_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"partition_position" bigint NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"duplicate_risk_acknowledged" boolean DEFAULT false NOT NULL,
	"data_loss_acknowledged" boolean DEFAULT false NOT NULL,
	"decision_revision" integer NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_lease_generation" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_delivery_operator_decision_retry_authority_unique" UNIQUE("id","delivery_id","action"),
	CONSTRAINT "external_delivery_operator_decision_coordinates_valid" CHECK (length(btrim("external_delivery_operator_decisions"."binding_id")) > 0
      AND length("external_delivery_operator_decisions"."binding_id") <= 160
      AND "external_delivery_operator_decisions"."binding_epoch" > 0
      AND "external_delivery_operator_decisions"."partition_position" > 0
      AND "external_delivery_operator_decisions"."decision_revision" > 0
      AND length(btrim("external_delivery_operator_decisions"."actor_id")) > 0
      AND length("external_delivery_operator_decisions"."actor_id") <= 160
      AND length(btrim("external_delivery_operator_decisions"."reason")) > 0
      AND length("external_delivery_operator_decisions"."reason") <= 320),
	CONSTRAINT "external_delivery_operator_decision_closed_values" CHECK ("external_delivery_operator_decisions"."action" IN ('retry_in_place', 'skip')
      AND "external_delivery_operator_decisions"."actor_type" IN ('user', 'agent')),
	CONSTRAINT "external_delivery_operator_decision_ack_valid" CHECK (("external_delivery_operator_decisions"."action" = 'retry_in_place'
        AND "external_delivery_operator_decisions"."duplicate_risk_acknowledged" = true
        AND "external_delivery_operator_decisions"."data_loss_acknowledged" = false)
      OR ("external_delivery_operator_decisions"."action" = 'skip'
        AND "external_delivery_operator_decisions"."duplicate_risk_acknowledged" = false
        AND "external_delivery_operator_decisions"."data_loss_acknowledged" = true)),
	CONSTRAINT "external_delivery_operator_decision_consumption_shape" CHECK (("external_delivery_operator_decisions"."consumed_at" IS NULL AND "external_delivery_operator_decisions"."consumed_lease_generation" IS NULL)
      OR ("external_delivery_operator_decisions"."consumed_at" IS NOT NULL
        AND "external_delivery_operator_decisions"."consumed_lease_generation" IS NOT NULL
        AND "external_delivery_operator_decisions"."consumed_lease_generation" > 0))
);
--> statement-breakpoint
CREATE TABLE "external_delivery_partitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"last_enqueued_position" bigint DEFAULT 0 NOT NULL,
	"cursor_position" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_delivery_partition_epoch_unique" UNIQUE("binding_id","binding_epoch"),
	CONSTRAINT "external_delivery_partition_positions_valid" CHECK (length(btrim("external_delivery_partitions"."binding_id")) > 0
      AND length("external_delivery_partitions"."binding_id") <= 160
      AND "external_delivery_partitions"."binding_epoch" > 0
      AND "external_delivery_partitions"."last_enqueued_position" >= 0
      AND "external_delivery_partitions"."cursor_position" >= 0
      AND "external_delivery_partitions"."cursor_position" <= "external_delivery_partitions"."last_enqueued_position")
);
--> statement-breakpoint
CREATE TABLE "external_human_identity_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"link_epoch" integer DEFAULT 1 NOT NULL,
	"observed_connection_epoch" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_human_identity_provider_valid" CHECK ("external_human_identity_links"."provider" = 'slack'),
	CONSTRAINT "external_human_identity_values_present" CHECK (length(btrim("external_human_identity_links"."provider_authority_id")) > 0 AND length(btrim("external_human_identity_links"."provider_user_id")) > 0),
	CONSTRAINT "external_human_identity_epochs_positive" CHECK ("external_human_identity_links"."link_epoch" > 0 AND "external_human_identity_links"."observed_connection_epoch" > 0),
	CONSTRAINT "external_human_identity_revocation_valid" CHECK (("external_human_identity_links"."state" = 'active' AND "external_human_identity_links"."revoked_at" IS NULL AND "external_human_identity_links"."revoke_reason" IS NULL)
      OR ("external_human_identity_links"."state" = 'revoked' AND "external_human_identity_links"."revoked_at" IS NOT NULL AND length(btrim("external_human_identity_links"."revoke_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "external_inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"connection_epoch" integer NOT NULL,
	"runtime_revision" text NOT NULL,
	"raft_channel_id" uuid NOT NULL,
	"privacy_class" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"normalized_payload_digest" text NOT NULL,
	"encrypted_payload" text,
	"envelope_key_id" text,
	"payload_aad_purpose" text DEFAULT 'external-inbound-normalized-event' NOT NULL,
	"payload_aad_version" integer DEFAULT 1 NOT NULL,
	"payload_schema_version" integer DEFAULT 1 NOT NULL,
	"payload_expires_at" timestamp with time zone,
	"payload_erased_at" timestamp with time zone,
	"payload_tombstone_digest" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"committed_message_id" uuid,
	"outcome_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_inbound_event_coordinates_valid" CHECK (length(btrim("external_inbound_events"."provider")) > 0
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
      AND "external_inbound_events"."payload_aad_version" = 1 AND "external_inbound_events"."payload_schema_version" = 1),
	CONSTRAINT "external_inbound_event_status_valid" CHECK ("external_inbound_events"."status" IN (
      'queued', 'processing', 'committed', 'duplicate', 'echo', 'quarantined', 'dead', 'revoked'
    )),
	CONSTRAINT "external_inbound_event_lease_shape" CHECK (("external_inbound_events"."status" = 'processing'
        AND "external_inbound_events"."lease_owner" IS NOT NULL
        AND length(btrim("external_inbound_events"."lease_owner")) > 0
        AND length("external_inbound_events"."lease_owner") <= 160
        AND "external_inbound_events"."lease_expires_at" IS NOT NULL
        AND "external_inbound_events"."lease_generation" > 0)
      OR ("external_inbound_events"."status" <> 'processing'
        AND "external_inbound_events"."lease_owner" IS NULL
        AND "external_inbound_events"."lease_expires_at" IS NULL
        AND "external_inbound_events"."lease_generation" >= 0)),
	CONSTRAINT "external_inbound_event_custody_shape" CHECK (("external_inbound_events"."status" IN ('queued', 'processing')
        AND "external_inbound_events"."encrypted_payload" IS NOT NULL
        AND length(btrim("external_inbound_events"."encrypted_payload")) > 0
        AND octet_length("external_inbound_events"."encrypted_payload") <= 1048576
        AND "external_inbound_events"."envelope_key_id" IS NOT NULL
        AND length(btrim("external_inbound_events"."envelope_key_id")) > 0
        AND length("external_inbound_events"."envelope_key_id") <= 320
        AND "external_inbound_events"."payload_expires_at" IS NOT NULL
        AND "external_inbound_events"."payload_expires_at" > "external_inbound_events"."received_at"
        AND "external_inbound_events"."payload_erased_at" IS NULL
        AND "external_inbound_events"."payload_tombstone_digest" IS NULL
        AND "external_inbound_events"."committed_message_id" IS NULL)
      OR ("external_inbound_events"."status" NOT IN ('queued', 'processing')
        AND "external_inbound_events"."encrypted_payload" IS NULL
        AND "external_inbound_events"."envelope_key_id" IS NULL
        AND "external_inbound_events"."payload_expires_at" IS NULL
        AND "external_inbound_events"."payload_erased_at" IS NOT NULL
        AND "external_inbound_events"."payload_tombstone_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "external_inbound_event_terminal_shape" CHECK (("external_inbound_events"."status" IN ('committed', 'duplicate', 'echo') AND "external_inbound_events"."committed_message_id" IS NOT NULL)
      OR ("external_inbound_events"."status" NOT IN ('committed', 'duplicate', 'echo') AND "external_inbound_events"."committed_message_id" IS NULL)),
	CONSTRAINT "external_inbound_event_reason_bounded" CHECK ("external_inbound_events"."outcome_reason" IS NULL
      OR (length(btrim("external_inbound_events"."outcome_reason")) > 0 AND length("external_inbound_events"."outcome_reason") <= 160))
);
--> statement-breakpoint
CREATE TABLE "external_ingress_discard_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"app_registration_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"endpoint_revision" integer NOT NULL,
	"signing_secret_revision" integer NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_conversation_id" text,
	"provider_event_id" text NOT NULL,
	"outcome_reason" text NOT NULL,
	"slack_retry_num" text,
	"slack_retry_reason" text,
	"payload_digest" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ingress_discard_coordinates_valid" CHECK (length(btrim("external_ingress_discard_receipts"."provider")) > 0
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
        'provider_tokens_unrelated',
        'provider_loop_suppressed',
        'unsupported_message_subtype'
      )
      AND ("external_ingress_discard_receipts"."slack_retry_num" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_num")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_num") <= 32
      ))
      AND ("external_ingress_discard_receipts"."slack_retry_reason" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_reason")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_reason") <= 160
      ))
      AND "external_ingress_discard_receipts"."payload_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "external_mention_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"projection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"external_actor_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"member_revision" integer NOT NULL,
	"context_revision" integer NOT NULL,
	"freshness_observed_at" timestamp with time zone NOT NULL,
	"freshness_expires_at" timestamp with time zone NOT NULL,
	"handle_at_send_time" text NOT NULL,
	"resolution_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_mention_fact_values_valid" CHECK (length(btrim("external_mention_facts"."provider")) > 0
      AND length(btrim("external_mention_facts"."app_registration_id")) > 0
      AND length(btrim("external_mention_facts"."install_id")) > 0
      AND length(btrim("external_mention_facts"."workspace_id")) > 0
      AND length(btrim("external_mention_facts"."external_actor_id")) > 0
      AND length(btrim("external_mention_facts"."binding_id")) > 0
      AND length(btrim("external_mention_facts"."conversation_id")) > 0
      AND length(btrim("external_mention_facts"."handle_at_send_time")) > 0
      AND "external_mention_facts"."connection_epoch" > 0 AND "external_mention_facts"."binding_epoch" > 0
      AND "external_mention_facts"."member_revision" > 0 AND "external_mention_facts"."context_revision" > 0
      AND "external_mention_facts"."freshness_expires_at" > "external_mention_facts"."freshness_observed_at"
      AND "external_mention_facts"."resolution_reason" IN ('explicit_projection', 'unique_dangling_handle'))
);
--> statement-breakpoint
CREATE TABLE "external_message_author_facts" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"projection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"external_actor_id" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"display_name" text NOT NULL,
	"actor_kind" text NOT NULL,
	"avatar_artifact_id" uuid,
	"avatar_url" text,
	"avatar_digest" text,
	"content_digest" text NOT NULL,
	"actor_projection_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_message_author_values_valid" CHECK (length(btrim("external_message_author_facts"."provider")) > 0
      AND length(btrim("external_message_author_facts"."app_registration_id")) > 0
      AND length(btrim("external_message_author_facts"."install_id")) > 0
      AND length(btrim("external_message_author_facts"."workspace_id")) > 0
      AND length(btrim("external_message_author_facts"."external_actor_id")) > 0
      AND length(btrim("external_message_author_facts"."external_conversation_id")) > 0
      AND length(btrim("external_message_author_facts"."external_message_id")) > 0
      AND length(btrim("external_message_author_facts"."display_name")) > 0
      AND "external_message_author_facts"."content_digest" ~ '^[0-9a-f]{64}$'
      AND "external_message_author_facts"."actor_kind" IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND "external_message_author_facts"."actor_projection_revision" > 0
      AND (("external_message_author_facts"."avatar_artifact_id" IS NULL AND "external_message_author_facts"."avatar_url" IS NULL AND "external_message_author_facts"."avatar_digest" IS NULL)
        OR ("external_message_author_facts"."avatar_artifact_id" IS NOT NULL AND "external_message_author_facts"."avatar_url" ~ '^https://' AND "external_message_author_facts"."avatar_digest" ~ '^[0-9a-f]{64}$')))
);
--> statement-breakpoint
CREATE TABLE "external_message_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid,
	"provider" text NOT NULL,
	"install_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_message_id" text,
	"provider_thread_id" text,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"connection_epoch" integer NOT NULL,
	"raft_message_id" uuid NOT NULL,
	"raft_canonical_root_message_id" uuid,
	"first_direction" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"outcome_state" text NOT NULL,
	"authority_state" text DEFAULT 'active' NOT NULL,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_message_link_coordinates_valid" CHECK (length(btrim("external_message_links"."provider")) > 0
      AND length("external_message_links"."provider") <= 80
      AND length(btrim("external_message_links"."install_id")) > 0
      AND length("external_message_links"."install_id") <= 160
      AND length(btrim("external_message_links"."provider_authority_id")) > 0
      AND length("external_message_links"."provider_authority_id") <= 160
      AND length(btrim("external_message_links"."provider_conversation_id")) > 0
      AND length("external_message_links"."provider_conversation_id") <= 160
      AND length(btrim("external_message_links"."binding_id")) > 0
      AND length("external_message_links"."binding_id") <= 160
      AND "external_message_links"."binding_epoch" > 0
      AND "external_message_links"."connection_epoch" > 0
      AND ("external_message_links"."provider_message_id" IS NULL
        OR (length(btrim("external_message_links"."provider_message_id")) > 0 AND length("external_message_links"."provider_message_id") <= 160))
      AND ("external_message_links"."provider_thread_id" IS NULL
        OR (length(btrim("external_message_links"."provider_thread_id")) > 0 AND length("external_message_links"."provider_thread_id") <= 160))
      AND "external_message_links"."payload_fingerprint" ~ '^[0-9a-f]{64}$'
      AND ("external_message_links"."state_reason" IS NULL
        OR (length(btrim("external_message_links"."state_reason")) > 0 AND length("external_message_links"."state_reason") <= 160))),
	CONSTRAINT "external_message_link_closed_values" CHECK ("external_message_links"."first_direction" IN ('raft_outbound', 'provider_inbound')
      AND "external_message_links"."outcome_state" IN ('unknown', 'accepted')
      AND "external_message_links"."authority_state" IN ('active', 'stale')),
	CONSTRAINT "external_message_link_outcome_shape" CHECK (("external_message_links"."outcome_state" = 'unknown' AND "external_message_links"."provider_message_id" IS NULL)
      OR ("external_message_links"."outcome_state" = 'accepted' AND "external_message_links"."provider_message_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_oauth_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"server_grant_id" uuid NOT NULL,
	"grant_epoch" integer NOT NULL,
	"requesting_user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"environment" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"grant_intent_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchange_started_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_oauth_attempt_status_valid" CHECK ("external_oauth_attempts"."status" IN ('pending', 'exchanging', 'consumed', 'exchange_unknown')),
	CONSTRAINT "external_oauth_attempt_environment_valid" CHECK ("external_oauth_attempts"."environment" IN ('test', 'production')),
	CONSTRAINT "external_oauth_attempt_epoch_positive" CHECK ("external_oauth_attempts"."grant_epoch" > 0 AND "external_oauth_attempts"."manifest_version" > 0),
	CONSTRAINT "external_oauth_attempt_transition_shape" CHECK (("external_oauth_attempts"."status" = 'pending' AND "external_oauth_attempts"."exchange_started_at" IS NULL AND "external_oauth_attempts"."consumed_at" IS NULL)
      OR ("external_oauth_attempts"."status" IN ('exchanging', 'exchange_unknown') AND "external_oauth_attempts"."exchange_started_at" IS NOT NULL AND "external_oauth_attempts"."consumed_at" IS NULL)
      OR ("external_oauth_attempts"."status" = 'consumed' AND "external_oauth_attempts"."exchange_started_at" IS NOT NULL AND "external_oauth_attempts"."consumed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_outbound_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_message_id" uuid NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"partition_position" bigint NOT NULL,
	"delivery_contract_version" text DEFAULT 'slack-bridge-delivery.v1' NOT NULL,
	"enqueue_runtime_revision" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"render_snapshot_schema" text DEFAULT 'slack-bridge-render-snapshot.v1' NOT NULL,
	"render_snapshot" jsonb NOT NULL,
	"render_snapshot_digest" text NOT NULL,
	"reconciliation_marker" text NOT NULL,
	"provider_attempts" integer DEFAULT 0 NOT NULL,
	"ambiguity_budget_provider_attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_failure_attempts" integer DEFAULT 0 NOT NULL,
	"first_dispatched_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"lease_origin_state" text,
	"lease_origin_next_attempt_at" timestamp with time zone,
	"provider_message_id" text,
	"accepted_at" timestamp with time zone,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_outbound_delivery_exact_coordinates_unique" UNIQUE("id","binding_id","binding_epoch","partition_position"),
	CONSTRAINT "external_outbound_delivery_exact_source_unique" UNIQUE("id","binding_id","binding_epoch","source_message_id"),
	CONSTRAINT "external_outbound_delivery_contract_valid" CHECK ("external_outbound_deliveries"."delivery_contract_version" = 'slack-bridge-delivery.v1'
      AND "external_outbound_deliveries"."render_snapshot_schema" = 'slack-bridge-render-snapshot.v1'),
	CONSTRAINT "external_outbound_delivery_state_valid" CHECK ("external_outbound_deliveries"."state" IN (
      'not_queued', 'queued', 'dispatching', 'accepted', 'retry_wait',
      'outcome_unknown', 'dead', 'skipped', 'revoked', 'quarantined'
    )),
	CONSTRAINT "external_outbound_delivery_coordinates_valid" CHECK (length(btrim("external_outbound_deliveries"."binding_id")) > 0
      AND length("external_outbound_deliveries"."binding_id") <= 160
      AND "external_outbound_deliveries"."binding_epoch" > 0
      AND "external_outbound_deliveries"."partition_position" > 0
      AND length(btrim("external_outbound_deliveries"."enqueue_runtime_revision")) > 0
      AND length("external_outbound_deliveries"."enqueue_runtime_revision") <= 160
      AND "external_outbound_deliveries"."render_snapshot_digest" ~ '^[0-9a-f]{64}$'
      AND "external_outbound_deliveries"."reconciliation_marker" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "external_outbound_delivery_attempts_valid" CHECK ("external_outbound_deliveries"."provider_attempts" >= 0
      AND "external_outbound_deliveries"."ambiguity_budget_provider_attempts" >= 0
      AND "external_outbound_deliveries"."ambiguity_budget_provider_attempts" <= "external_outbound_deliveries"."provider_attempts"
      AND "external_outbound_deliveries"."dispatched_failure_attempts" >= 0
      AND "external_outbound_deliveries"."dispatched_failure_attempts" <= 24
      AND "external_outbound_deliveries"."dispatched_failure_attempts" <= "external_outbound_deliveries"."provider_attempts"
      AND (("external_outbound_deliveries"."provider_attempts" = 0 AND "external_outbound_deliveries"."first_dispatched_at" IS NULL)
        OR ("external_outbound_deliveries"."provider_attempts" > 0 AND "external_outbound_deliveries"."first_dispatched_at" IS NOT NULL))
      AND ("external_outbound_deliveries"."state" NOT IN ('accepted', 'retry_wait', 'outcome_unknown', 'dead')
        OR "external_outbound_deliveries"."provider_attempts" > 0)),
	CONSTRAINT "external_outbound_delivery_retry_shape" CHECK (("external_outbound_deliveries"."state" = 'retry_wait' AND "external_outbound_deliveries"."next_attempt_at" IS NOT NULL)
      OR ("external_outbound_deliveries"."state" <> 'retry_wait' AND "external_outbound_deliveries"."next_attempt_at" IS NULL)),
	CONSTRAINT "external_outbound_delivery_lease_shape" CHECK (("external_outbound_deliveries"."state" = 'dispatching'
        AND "external_outbound_deliveries"."lease_owner" IS NOT NULL
        AND length(btrim("external_outbound_deliveries"."lease_owner")) > 0
        AND length("external_outbound_deliveries"."lease_owner") <= 160
        AND "external_outbound_deliveries"."lease_expires_at" IS NOT NULL
        AND "external_outbound_deliveries"."lease_generation" > 0
        AND "external_outbound_deliveries"."lease_origin_state" IN ('queued', 'retry_wait', 'outcome_unknown', 'dead')
        AND (("external_outbound_deliveries"."lease_origin_state" = 'retry_wait' AND "external_outbound_deliveries"."lease_origin_next_attempt_at" IS NOT NULL)
          OR ("external_outbound_deliveries"."lease_origin_state" <> 'retry_wait' AND "external_outbound_deliveries"."lease_origin_next_attempt_at" IS NULL)))
      OR ("external_outbound_deliveries"."state" <> 'dispatching'
        AND "external_outbound_deliveries"."lease_owner" IS NULL
        AND "external_outbound_deliveries"."lease_expires_at" IS NULL
        AND "external_outbound_deliveries"."lease_origin_state" IS NULL
        AND "external_outbound_deliveries"."lease_origin_next_attempt_at" IS NULL
        AND "external_outbound_deliveries"."lease_generation" >= 0)),
	CONSTRAINT "external_outbound_delivery_acceptance_shape" CHECK (("external_outbound_deliveries"."state" = 'accepted'
        AND "external_outbound_deliveries"."provider_message_id" IS NOT NULL
        AND length(btrim("external_outbound_deliveries"."provider_message_id")) > 0
        AND length("external_outbound_deliveries"."provider_message_id") <= 160
        AND "external_outbound_deliveries"."accepted_at" IS NOT NULL)
      OR ("external_outbound_deliveries"."state" <> 'accepted' AND "external_outbound_deliveries"."provider_message_id" IS NULL AND "external_outbound_deliveries"."accepted_at" IS NULL)),
	CONSTRAINT "external_outbound_delivery_reason_bounded" CHECK ("external_outbound_deliveries"."state_reason" IS NULL
      OR (length(btrim("external_outbound_deliveries"."state_reason")) > 0 AND length("external_outbound_deliveries"."state_reason") <= 160))
);
--> statement-breakpoint
CREATE TABLE "external_projection_avatar_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"public_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"artifact_revision" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_avatar_shape_valid" CHECK ("external_projection_avatar_artifacts"."owner_type" IN ('user', 'agent', 'external_projection')
      AND length(btrim("external_projection_avatar_artifacts"."owner_id")) > 0
      AND "external_projection_avatar_artifacts"."source_digest" ~ '^[0-9a-f]{64}$'
      AND "external_projection_avatar_artifacts"."public_url" ~ '^https://'
      AND "external_projection_avatar_artifacts"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp')
      AND "external_projection_avatar_artifacts"."byte_size" > 0 AND "external_projection_avatar_artifacts"."byte_size" <= 5242880
      AND "external_projection_avatar_artifacts"."width" > 0 AND "external_projection_avatar_artifacts"."width" <= 4096
      AND "external_projection_avatar_artifacts"."height" > 0 AND "external_projection_avatar_artifacts"."height" <= 4096
      AND "external_projection_avatar_artifacts"."artifact_revision" > 0
      AND "external_projection_avatar_artifacts"."state" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD CONSTRAINT "external_actor_projections_avatar_artifact_id_external_projection_avatar_artifacts_id_fk" FOREIGN KEY ("avatar_artifact_id") REFERENCES "public"."external_projection_avatar_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_addressability_projections" ADD CONSTRAINT "external_addressability_projections_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_credentials" ADD CONSTRAINT "external_app_credentials_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_ingress_endpoints" ADD CONSTRAINT "external_app_ingress_endpoints_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_install_grant_receipts" ADD CONSTRAINT "external_app_install_grant_receipts_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_install_grant_receipts" ADD CONSTRAINT "external_app_install_grant_receipts_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD CONSTRAINT "external_app_installs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD CONSTRAINT "external_app_installs_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_installs" ADD CONSTRAINT "external_app_installs_server_grant_id_external_app_server_grants_id_fk" FOREIGN KEY ("server_grant_id") REFERENCES "public"."external_app_server_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_manifest_receipts" ADD CONSTRAINT "external_app_manifest_receipts_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_registration_secrets" ADD CONSTRAINT "external_app_registration_secrets_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_registrations" ADD CONSTRAINT "external_app_registrations_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_server_grants" ADD CONSTRAINT "external_app_server_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_app_server_grants" ADD CONSTRAINT "external_app_server_grants_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_author_policies" ADD CONSTRAINT "external_author_policies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_author_policies" ADD CONSTRAINT "external_author_policies_avatar_artifact_id_external_projection_avatar_artifacts_id_fk" FOREIGN KEY ("avatar_artifact_id") REFERENCES "public"."external_projection_avatar_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_binding_audience_snapshots" ADD CONSTRAINT "external_binding_audience_snapshots_binding_id_external_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."external_channel_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_delivery_attempts" ADD CONSTRAINT "external_delivery_attempts_delivery_id_external_outbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."external_outbound_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_delivery_attempts" ADD CONSTRAINT "external_delivery_attempts_retry_decision_fk" FOREIGN KEY ("operator_decision_id","delivery_id","operator_decision_action") REFERENCES "public"."external_delivery_operator_decisions"("id","delivery_id","action") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_delivery_operator_decisions" ADD CONSTRAINT "external_delivery_operator_decisions_exact_delivery_fk" FOREIGN KEY ("delivery_id","binding_id","binding_epoch","partition_position") REFERENCES "public"."external_outbound_deliveries"("id","binding_id","binding_epoch","partition_position") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_human_identity_links" ADD CONSTRAINT "external_human_identity_links_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_human_identity_links" ADD CONSTRAINT "external_human_identity_links_install_id_external_app_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."external_app_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_human_identity_links" ADD CONSTRAINT "external_human_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_inbound_events" ADD CONSTRAINT "external_inbound_events_raft_channel_id_channels_id_fk" FOREIGN KEY ("raft_channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_inbound_events" ADD CONSTRAINT "external_inbound_events_committed_message_id_messages_id_fk" FOREIGN KEY ("committed_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" ADD CONSTRAINT "external_ingress_discard_receipts_app_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("app_registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" ADD CONSTRAINT "external_ingress_discard_receipts_endpoint_id_external_app_ingress_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."external_app_ingress_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_mention_facts" ADD CONSTRAINT "external_mention_facts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_mention_facts" ADD CONSTRAINT "external_mention_facts_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD CONSTRAINT "external_message_author_facts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD CONSTRAINT "external_message_author_facts_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD CONSTRAINT "external_message_author_facts_avatar_artifact_id_external_projection_avatar_artifacts_id_fk" FOREIGN KEY ("avatar_artifact_id") REFERENCES "public"."external_projection_avatar_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_links" ADD CONSTRAINT "external_message_links_raft_message_id_messages_id_fk" FOREIGN KEY ("raft_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_links" ADD CONSTRAINT "external_message_links_raft_canonical_root_message_id_messages_id_fk" FOREIGN KEY ("raft_canonical_root_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_message_links" ADD CONSTRAINT "external_message_links_exact_delivery_fk" FOREIGN KEY ("delivery_id","binding_id","binding_epoch","raft_message_id") REFERENCES "public"."external_outbound_deliveries"("id","binding_id","binding_epoch","source_message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_oauth_attempts" ADD CONSTRAINT "external_oauth_attempts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_oauth_attempts" ADD CONSTRAINT "external_oauth_attempts_registration_id_external_app_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."external_app_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_oauth_attempts" ADD CONSTRAINT "external_oauth_attempts_server_grant_id_external_app_server_grants_id_fk" FOREIGN KEY ("server_grant_id") REFERENCES "public"."external_app_server_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_oauth_attempts" ADD CONSTRAINT "external_oauth_attempts_requesting_user_id_users_id_fk" FOREIGN KEY ("requesting_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD CONSTRAINT "external_outbound_deliveries_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD CONSTRAINT "external_outbound_deliveries_partition_fk" FOREIGN KEY ("binding_id","binding_epoch") REFERENCES "public"."external_delivery_partitions"("binding_id","binding_epoch") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_actor_provider_identity" ON "external_actor_projections" USING btree ("provider","app_registration_id","install_id","workspace_id","external_actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_actor_projection_revision" ON "external_actor_projections" USING btree ("id","projection_revision");--> statement-breakpoint
CREATE INDEX "idx_external_actor_workspace_state" ON "external_actor_projections" USING btree ("provider","workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_addressability_context_actor" ON "external_addressability_projections" USING btree ("projection_id","binding_id","binding_epoch","conversation_id","context_revision");--> statement-breakpoint
CREATE INDEX "idx_external_addressability_context_lookup" ON "external_addressability_projections" USING btree ("provider","workspace_id","binding_id","binding_epoch","conversation_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_credentials_install" ON "external_app_credentials" USING btree ("install_id");--> statement-breakpoint
CREATE INDEX "idx_external_app_credentials_lease" ON "external_app_credentials" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_ingress_endpoint_registration" ON "external_app_ingress_endpoints" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_ingress_endpoint_url" ON "external_app_ingress_endpoints" USING btree ("environment","exact_request_url");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_install_grant_receipt_revision" ON "external_app_install_grant_receipts" USING btree ("install_id","receipt_revision");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_grant_receipt_freshness" ON "external_app_install_grant_receipts" USING btree ("install_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_install_authority" ON "external_app_installs" USING btree ("registration_id","authority_type","provider_authority_id");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_server_state" ON "external_app_installs" USING btree ("server_id","state");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_grant" ON "external_app_installs" USING btree ("server_grant_id","grant_epoch");--> statement-breakpoint
CREATE INDEX "idx_external_app_install_grant_renewal_lease" ON "external_app_installs" USING btree ("install_grant_renewal_lease_expires_at","install_grant_renewal_next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_manifest_receipt_revision" ON "external_app_manifest_receipts" USING btree ("registration_id","receipt_revision");--> statement-breakpoint
CREATE INDEX "idx_external_app_manifest_receipt_freshness" ON "external_app_manifest_receipts" USING btree ("registration_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_registration_secret_purpose" ON "external_app_registration_secrets" USING btree ("registration_id","purpose");--> statement-breakpoint
CREATE INDEX "idx_external_app_registration_secret_lease" ON "external_app_registration_secrets" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_registrations_oauth_client_env" ON "external_app_registrations" USING btree ("oauth_client_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_registrations_provider_app" ON "external_app_registrations" USING btree ("provider","environment","provider_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_registrations_provider_oauth" ON "external_app_registrations" USING btree ("provider","environment","provider_oauth_client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_app_server_grants_server_registration" ON "external_app_server_grants" USING btree ("server_id","registration_id");--> statement-breakpoint
CREATE INDEX "idx_external_app_server_grants_state" ON "external_app_server_grants" USING btree ("registration_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_author_policy_epoch" ON "external_author_policies" USING btree ("provider","install_id","binding_id","binding_epoch","author_type","author_id");--> statement-breakpoint
CREATE INDEX "idx_external_author_policy_server_state" ON "external_author_policies" USING btree ("server_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_binding_audience_revision" ON "external_binding_audience_snapshots" USING btree ("binding_id","binding_epoch","audience_revision");--> statement-breakpoint
CREATE INDEX "idx_external_binding_audience_freshness" ON "external_binding_audience_snapshots" USING btree ("binding_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_channel_binding_source" ON "external_channel_bindings" USING btree ("registration_id","channel_id") WHERE "external_channel_bindings"."state" IN ('active', 'paused', 'quarantined');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_channel_binding_target" ON "external_channel_bindings" USING btree ("install_id","provider_conversation_id") WHERE "external_channel_bindings"."state" IN ('active', 'paused', 'quarantined');--> statement-breakpoint
CREATE INDEX "idx_external_channel_binding_server_state" ON "external_channel_bindings" USING btree ("server_id","state");--> statement-breakpoint
CREATE INDEX "idx_external_channel_binding_install_epoch" ON "external_channel_bindings" USING btree ("install_id","connection_epoch","binding_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_delivery_attempt_number" ON "external_delivery_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_delivery_attempt_lease_generation" ON "external_delivery_attempts" USING btree ("delivery_id","lease_generation");--> statement-breakpoint
CREATE INDEX "idx_external_delivery_attempt_started" ON "external_delivery_attempts" USING btree ("outcome","provider_io_started_at");--> statement-breakpoint
CREATE INDEX "idx_external_delivery_operator_decision_delivery" ON "external_delivery_operator_decisions" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_human_identity_active_user" ON "external_human_identity_links" USING btree ("install_id","user_id") WHERE "external_human_identity_links"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_human_identity_active_provider_user" ON "external_human_identity_links" USING btree ("install_id","provider_user_id") WHERE "external_human_identity_links"."state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_external_human_identity_server_state" ON "external_human_identity_links" USING btree ("server_id","state");--> statement-breakpoint
CREATE INDEX "idx_external_human_identity_history" ON "external_human_identity_links" USING btree ("install_id","user_id","link_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_inbound_event_identity" ON "external_inbound_events" USING btree ("provider","app_registration_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_external_inbound_event_work" ON "external_inbound_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "idx_external_inbound_event_lease" ON "external_inbound_events" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_external_ingress_discard_event" ON "external_ingress_discard_receipts" USING btree ("provider","app_registration_id","provider_event_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_mention_message_projection" ON "external_mention_facts" USING btree ("message_id","projection_id");--> statement-breakpoint
CREATE INDEX "idx_external_mention_binding_epoch" ON "external_mention_facts" USING btree ("binding_id","binding_epoch","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_message_provider_identity" ON "external_message_author_facts" USING btree ("provider","install_id","workspace_id","external_conversation_id","external_message_id");--> statement-breakpoint
CREATE INDEX "idx_external_message_author_projection" ON "external_message_author_facts" USING btree ("projection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_message_link_delivery" ON "external_message_links" USING btree ("delivery_id") WHERE "external_message_links"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_message_link_provider_identity" ON "external_message_links" USING btree ("provider","install_id","provider_authority_id","provider_conversation_id","provider_message_id") WHERE "external_message_links"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_message_link_raft_identity" ON "external_message_links" USING btree ("binding_id","binding_epoch","raft_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_oauth_attempt_state" ON "external_oauth_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "idx_external_oauth_attempt_scope" ON "external_oauth_attempts" USING btree ("server_id","registration_id","status");--> statement-breakpoint
CREATE INDEX "idx_external_oauth_attempt_expiry" ON "external_oauth_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_outbound_delivery_source_epoch" ON "external_outbound_deliveries" USING btree ("source_message_id","binding_id","binding_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_outbound_delivery_partition_position" ON "external_outbound_deliveries" USING btree ("binding_id","binding_epoch","partition_position");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_outbound_delivery_reconciliation_marker" ON "external_outbound_deliveries" USING btree ("reconciliation_marker");--> statement-breakpoint
CREATE INDEX "idx_external_outbound_delivery_head" ON "external_outbound_deliveries" USING btree ("binding_id","binding_epoch","state","partition_position");--> statement-breakpoint
CREATE INDEX "idx_external_outbound_delivery_retry" ON "external_outbound_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_external_outbound_delivery_lease" ON "external_outbound_deliveries" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_avatar_owner_revision" ON "external_projection_avatar_artifacts" USING btree ("owner_type","owner_id","artifact_revision");--> statement-breakpoint
CREATE INDEX "idx_external_avatar_digest" ON "external_projection_avatar_artifacts" USING btree ("source_digest");--> statement-breakpoint
CREATE INDEX "idx_external_avatar_owner_state" ON "external_projection_avatar_artifacts" USING btree ("owner_type","owner_id","state");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_external_delivery_partition_tail_consistent"(
	"checked_binding_id" text,
	"checked_binding_epoch" integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	"persisted_tail" bigint;
	"highest_delivery_position" bigint;
	"delivery_count" bigint;
BEGIN
	SELECT
		"partition"."last_enqueued_position",
		COALESCE(MAX("delivery"."partition_position"), 0),
		COUNT("delivery"."id")
	INTO "persisted_tail", "highest_delivery_position", "delivery_count"
	FROM "external_delivery_partitions" AS "partition"
	LEFT JOIN "external_outbound_deliveries" AS "delivery"
		ON "delivery"."binding_id" = "partition"."binding_id"
		AND "delivery"."binding_epoch" = "partition"."binding_epoch"
	WHERE "partition"."binding_id" = "checked_binding_id"
		AND "partition"."binding_epoch" = "checked_binding_epoch"
	GROUP BY "partition"."last_enqueued_position";

	-- A deleted empty partition has no invariant left to check. A delivery
	-- cannot outlive its partition because the ordinary FK remains RESTRICT.
	IF NOT FOUND THEN
		RETURN;
	END IF;

	-- Positions are unique and positive. Requiring both max(position)=tail and
	-- count(*)=tail therefore proves the complete contiguous set 1..tail, not
	-- merely that no row is ahead of the partition counter.
	IF "persisted_tail" <> "highest_delivery_position"
		OR "persisted_tail" <> "delivery_count"
	THEN
		RAISE EXCEPTION
			'External delivery partition tail % does not match delivery set (highest %, count %) for binding % epoch %',
			"persisted_tail",
			"highest_delivery_position",
			"delivery_count",
			"checked_binding_id",
			"checked_binding_epoch"
			USING ERRCODE = '23514',
				CONSTRAINT = 'external_delivery_partition_tail_consistent';
	END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "check_external_delivery_partition_tail_consistent"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP <> 'INSERT' THEN
		PERFORM "assert_external_delivery_partition_tail_consistent"(OLD."binding_id", OLD."binding_epoch");
	END IF;

	IF TG_OP <> 'DELETE' THEN
		PERFORM "assert_external_delivery_partition_tail_consistent"(NEW."binding_id", NEW."binding_epoch");
	END IF;

	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "external_delivery_partition_tail_after_partition"
AFTER INSERT OR UPDATE OR DELETE
ON "external_delivery_partitions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_external_delivery_partition_tail_consistent"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "external_delivery_partition_tail_after_delivery"
AFTER INSERT OR UPDATE OR DELETE
ON "external_outbound_deliveries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_external_delivery_partition_tail_consistent"();
