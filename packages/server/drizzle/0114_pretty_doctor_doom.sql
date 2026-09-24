CREATE TABLE "server_file_upload_usage_months" (
	"server_id" uuid NOT NULL,
	"month" text NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_file_upload_usage_months_server_id_month_pk" PRIMARY KEY("server_id","month")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "plan" text DEFAULT 'pro' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_interval" text DEFAULT 'annual' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_pro_pack_item_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provisioned_human_seats" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provisioned_agent_seats" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pro_pack_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_free_pack_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "first_pack_trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_provider_event_id" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "status" text DEFAULT 'processed' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "processing_token" text;--> statement-breakpoint
ALTER TABLE "server_file_upload_usage_months" ADD CONSTRAINT "server_file_upload_usage_months_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_server_file_upload_usage_months_server" ON "server_file_upload_usage_months" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subscriptions_plan" ON "subscriptions" USING btree ("plan");