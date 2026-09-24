CREATE TABLE "product_feedback_locators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"producer_agent_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"artifact_kind" text NOT NULL,
	"event_kind" text NOT NULL,
	"schema_version" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"runtime" text NOT NULL,
	"native_status" text NOT NULL,
	"native_lookup_method" text NOT NULL,
	"native_locator_kind" text NOT NULL,
	"has_served_exact" boolean NOT NULL,
	"served_exact_sha256" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"route_basis" text,
	"route_target" text,
	"payload_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_feedback_locators_artifact_kind" CHECK ("product_feedback_locators"."artifact_kind" = 'raft-feedback-locator-v0'),
	CONSTRAINT "product_feedback_locators_event_kind" CHECK ("product_feedback_locators"."event_kind" = 'feedback-locator:created'),
	CONSTRAINT "product_feedback_locators_schema_version" CHECK ("product_feedback_locators"."schema_version" = 'raft.feedback.locator.v0')
);
--> statement-breakpoint
ALTER TABLE "product_feedback_locators" ADD CONSTRAINT "product_feedback_locators_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_feedback_locators" ADD CONSTRAINT "product_feedback_locators_producer_agent_id_agents_id_fk" FOREIGN KEY ("producer_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_feedback_locators_server_report" ON "product_feedback_locators" USING btree ("server_id","report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_feedback_locators_receipt" ON "product_feedback_locators" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_locators_runtime" ON "product_feedback_locators" USING btree ("server_id","runtime");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_locators_native" ON "product_feedback_locators" USING btree ("server_id","native_status","native_lookup_method");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_locators_served_exact" ON "product_feedback_locators" USING btree ("server_id","has_served_exact");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_locators_served_exact_sha" ON "product_feedback_locators" USING gin ("served_exact_sha256");--> statement-breakpoint
CREATE INDEX "idx_product_feedback_locators_route_basis" ON "product_feedback_locators" USING btree ("server_id","route_basis");