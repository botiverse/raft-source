CREATE TABLE "integration_secret_commitments" (
	"label" text PRIMARY KEY NOT NULL,
	"commitment" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_secret_commitments_commitment_32" CHECK (octet_length("integration_secret_commitments"."commitment") = 32)
);
--> statement-breakpoint
CREATE TABLE "product_feedback_event_digest_conflicts" (
	"app_id" uuid NOT NULL,
	"reporter_integration_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"original_payload_sha256" "bytea" NOT NULL,
	"conflicting_payload_sha256" "bytea" NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_feedback_event_digest_conflicts_app_id_reporter_integration_id_event_id_conflicting_payload_sha256_pk" PRIMARY KEY("app_id","reporter_integration_id","event_id","conflicting_payload_sha256"),
	CONSTRAINT "product_feedback_event_digest_conflicts_original_32" CHECK (octet_length("product_feedback_event_digest_conflicts"."original_payload_sha256") = 32),
	CONSTRAINT "product_feedback_event_digest_conflicts_conflicting_32" CHECK (octet_length("product_feedback_event_digest_conflicts"."conflicting_payload_sha256") = 32),
	CONSTRAINT "product_feedback_event_digest_conflicts_distinct" CHECK ("product_feedback_event_digest_conflicts"."original_payload_sha256" <> "product_feedback_event_digest_conflicts"."conflicting_payload_sha256"),
	CONSTRAINT "product_feedback_event_digest_conflicts_count_positive" CHECK ("product_feedback_event_digest_conflicts"."occurrence_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_feedback_event_facts" (
	"app_id" uuid NOT NULL,
	"reporter_integration_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"raw_body_digest" "bytea" NOT NULL,
	"target_user_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"notification_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "product_feedback_event_facts_app_id_reporter_integration_id_event_id_pk" PRIMARY KEY("app_id","reporter_integration_id","event_id"),
	CONSTRAINT "product_feedback_event_facts_digest_32" CHECK (octet_length("product_feedback_event_facts"."raw_body_digest") = 32),
	CONSTRAINT "product_feedback_event_facts_seq_positive" CHECK ("product_feedback_event_facts"."notification_seq" > 0),
	CONSTRAINT "product_feedback_event_facts_kind_closed" CHECK ("product_feedback_event_facts"."event_kind" IN ('comment_created', 'status_changed')),
	CONSTRAINT "product_feedback_event_facts_outcome_closed" CHECK ("product_feedback_event_facts"."outcome" IN ('notified', 'suppressed')),
	CONSTRAINT "product_feedback_event_facts_read_state" CHECK (("product_feedback_event_facts"."outcome" = 'suppressed' AND "product_feedback_event_facts"."read_at" IS NULL) OR "product_feedback_event_facts"."outcome" = 'notified')
);
--> statement-breakpoint
CREATE TABLE "product_feedback_notification_cursors" (
	"target_user_id" uuid PRIMARY KEY NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "product_feedback_notification_cursors_next_positive" CHECK ("product_feedback_notification_cursors"."next_seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_feedback_read_cursors" (
	"target_user_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"last_token_nonce_digest" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_feedback_read_cursors_target_user_id_ticket_id_surface_pk" PRIMARY KEY("target_user_id","ticket_id","surface"),
	CONSTRAINT "product_feedback_read_cursors_surface_closed" CHECK ("product_feedback_read_cursors"."surface" = 'ticket_detail'),
	CONSTRAINT "product_feedback_read_cursors_seq_nonnegative" CHECK ("product_feedback_read_cursors"."last_read_seq" >= 0),
	CONSTRAINT "product_feedback_read_cursors_nonce_digest_32" CHECK ("product_feedback_read_cursors"."last_token_nonce_digest" IS NULL OR octet_length("product_feedback_read_cursors"."last_token_nonce_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "product_feedback_webhook_security_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"audit_identity_digest" "bytea" NOT NULL,
	"app_id_sha256" "bytea",
	"integration_id_sha256" "bytea",
	"header_event_id_sha256" "bytea",
	"envelope_event_id_sha256" "bytea",
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_feedback_webhook_security_audits_reason_closed" CHECK ("product_feedback_webhook_security_audits"."reason" IN ('event_id_missing', 'event_id_mismatch', 'coordinate_mismatch', 'schema_invalid')),
	CONSTRAINT "product_feedback_webhook_security_audits_count_positive" CHECK ("product_feedback_webhook_security_audits"."occurrence_count" > 0),
	CONSTRAINT "product_feedback_webhook_security_audits_identity_32" CHECK (octet_length("product_feedback_webhook_security_audits"."audit_identity_digest") = 32),
	CONSTRAINT "product_feedback_webhook_security_audits_app_32" CHECK ("product_feedback_webhook_security_audits"."app_id_sha256" IS NULL OR octet_length("product_feedback_webhook_security_audits"."app_id_sha256") = 32),
	CONSTRAINT "product_feedback_webhook_security_audits_integration_32" CHECK ("product_feedback_webhook_security_audits"."integration_id_sha256" IS NULL OR octet_length("product_feedback_webhook_security_audits"."integration_id_sha256") = 32),
	CONSTRAINT "product_feedback_webhook_security_audits_header_event_32" CHECK ("product_feedback_webhook_security_audits"."header_event_id_sha256" IS NULL OR octet_length("product_feedback_webhook_security_audits"."header_event_id_sha256") = 32),
	CONSTRAINT "product_feedback_webhook_security_audits_envelope_event_32" CHECK ("product_feedback_webhook_security_audits"."envelope_event_id_sha256" IS NULL OR octet_length("product_feedback_webhook_security_audits"."envelope_event_id_sha256") = 32)
);
--> statement-breakpoint
ALTER TABLE "product_feedback_event_facts" ADD CONSTRAINT "product_feedback_event_facts_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_feedback_notification_cursors" ADD CONSTRAINT "product_feedback_notification_cursors_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_feedback_read_cursors" ADD CONSTRAINT "product_feedback_read_cursors_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_feedback_event_facts_user_seq" ON "product_feedback_event_facts" USING btree ("target_user_id","notification_seq");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_event_facts_user_ticket_unread" ON "product_feedback_event_facts" USING btree ("target_user_id","ticket_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_feedback_webhook_security_audits_identity" ON "product_feedback_webhook_security_audits" USING btree ("reason","audit_identity_digest");