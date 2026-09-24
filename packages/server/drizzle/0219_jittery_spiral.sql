DROP INDEX "idx_agent_migrations_active_agent";--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "support_ref" text;--> statement-breakpoint
UPDATE "agent_migrations"
SET "support_ref" = 'mig_' || translate(rtrim(encode(uuid_send(gen_random_uuid()), 'base64'), '='), '+/', '-_')
WHERE "support_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ALTER COLUMN "support_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_generation" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_transport_generation" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_disposition" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_dispatch_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_last_dispatch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_attention_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_source_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_source_outcome" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_target_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_target_outcome" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_needs_attention_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_error_code" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "cancel_error_message" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_cancel_requested_by_user_id_users_id_fk" FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_migrations_active_agent" ON "agent_migrations" USING btree ("agent_id") WHERE "agent_migrations"."state" IN ('provisioning', 'prep', 'ready', 'in_transit', 'arriving', 'starting', 'cancel_requested_pre_flip', 'cancel_requested_post_flip');--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD CONSTRAINT "agent_migrations_support_ref_unique" UNIQUE("support_ref");
