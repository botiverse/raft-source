CREATE TABLE "feature_flag_rollout_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"reason" text NOT NULL,
	"control_plane_id" text NOT NULL,
	"flag_key" text NOT NULL,
	"config_version_before" bigint NOT NULL,
	"config_version_after" bigint NOT NULL,
	"authorization" text NOT NULL,
	"operation" jsonb NOT NULL,
	"receipt_id" uuid,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flag_rollout_audit_request_nonempty" CHECK (length(btrim("feature_flag_rollout_audit_events"."request_id")) > 0),
	CONSTRAINT "feature_flag_rollout_audit_reason_nonempty" CHECK (length(btrim("feature_flag_rollout_audit_events"."reason")) > 0),
	CONSTRAINT "feature_flag_rollout_audit_actor_type_valid" CHECK ("feature_flag_rollout_audit_events"."actor_type" IN ('human', 'agent', 'system')),
	CONSTRAINT "feature_flag_rollout_audit_authorization_valid" CHECK ("feature_flag_rollout_audit_events"."authorization" IN ('narrowing', 'guardrail_passed')),
	CONSTRAINT "feature_flag_rollout_audit_receipt_matches_authorization" CHECK ((
      ("feature_flag_rollout_audit_events"."authorization" = 'narrowing' AND "feature_flag_rollout_audit_events"."receipt_id" IS NULL)
      OR ("feature_flag_rollout_audit_events"."authorization" = 'guardrail_passed' AND "feature_flag_rollout_audit_events"."receipt_id" IS NOT NULL)
    )),
	CONSTRAINT "feature_flag_rollout_audit_version_before_nonnegative" CHECK ("feature_flag_rollout_audit_events"."config_version_before" >= 0),
	CONSTRAINT "feature_flag_rollout_audit_version_after_nonnegative" CHECK ("feature_flag_rollout_audit_events"."config_version_after" >= 0),
	CONSTRAINT "feature_flag_rollout_audit_version_step" CHECK ("feature_flag_rollout_audit_events"."config_version_after" = "feature_flag_rollout_audit_events"."config_version_before" + 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feature_flag_rollout_audit_version" ON "feature_flag_rollout_audit_events" USING btree ("config_version_after");--> statement-breakpoint
CREATE INDEX "idx_feature_flag_rollout_audit_request" ON "feature_flag_rollout_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_feature_flag_rollout_audit_flag_time" ON "feature_flag_rollout_audit_events" USING btree ("flag_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_feature_flag_rollout_audit_actor_time" ON "feature_flag_rollout_audit_events" USING btree ("actor_type","actor_id","created_at");