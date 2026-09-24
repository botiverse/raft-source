CREATE TABLE "product_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source" text,
	"idempotency_key" text,
	CONSTRAINT "product_events_subject_type_whitelist" CHECK ("product_events"."subject_type" IN ('action_card')),
	CONSTRAINT "product_events_event_type_whitelist" CHECK ("product_events"."event_type" IN (
      'action_card.open',
      'action_card.dismiss',
      'action_card.execute_attempt',
      'action_card.execute_success',
      'action_card.execute_fail',
      'action_card.expired'
    )),
	CONSTRAINT "product_events_actor_type_valid" CHECK ("product_events"."actor_type" IS NULL OR "product_events"."actor_type" IN ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE INDEX "idx_product_events_subject" ON "product_events" USING btree ("subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_product_events_type" ON "product_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_events_idempotency" ON "product_events" USING btree ("subject_id","event_type","idempotency_key") WHERE "product_events"."idempotency_key" IS NOT NULL;