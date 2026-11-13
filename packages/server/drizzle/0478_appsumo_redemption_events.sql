CREATE TABLE "appsumo_products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"next_api_request_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appsumo_redemption_claims" (
	"id" uuid NOT NULL,
	"token_hash" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"product_id" text NOT NULL,
	"license_key" uuid,
	"user_id" uuid,
	"bound_server_id" uuid,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "appsumo_redemption_claims_id_unique" UNIQUE("id"),
	CONSTRAINT "appsumo_redemption_claims_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "appsumo_claim_hash_check" CHECK ("appsumo_redemption_claims"."token_hash" ~ '^[0-9a-f]{64}$' and "appsumo_redemption_claims"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "appsumo_claim_state_check" CHECK ("appsumo_redemption_claims"."state" in ('exchanging', 'ready', 'consumed', 'failed')),
	CONSTRAINT "appsumo_claim_key_check" CHECK ("appsumo_redemption_claims"."state" not in ('ready', 'consumed') or "appsumo_redemption_claims"."license_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "appsumo_webhook_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"license_key" uuid NOT NULL,
	"event" text NOT NULL,
	"previous_license_key" uuid,
	"tier" integer,
	"provider_event_timestamp" bigint NOT NULL,
	"provider_created_at" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appsumo_webhook_receipt_unique" UNIQUE("product_id","request_digest"),
	CONSTRAINT "appsumo_webhook_digest_check" CHECK ("appsumo_webhook_receipts"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "appsumo_webhook_event_check" CHECK ("appsumo_webhook_receipts"."event" in ('purchase', 'activate', 'upgrade', 'downgrade', 'deactivate'))
);
--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD COLUMN "expected_status" text;--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD COLUMN "check_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD COLUMN "check_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD COLUMN "check_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appsumo_redemption_claims" ADD CONSTRAINT "appsumo_redemption_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appsumo_redemption_claims" ADD CONSTRAINT "appsumo_redemption_claims_bound_server_id_servers_id_fk" FOREIGN KEY ("bound_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appsumo_claim_expiry_idx" ON "appsumo_redemption_claims" USING btree ("product_id","expires_at");--> statement-breakpoint
CREATE INDEX "appsumo_webhook_license_idx" ON "appsumo_webhook_receipts" USING btree ("product_id","license_key");--> statement-breakpoint
CREATE INDEX "appsumo_license_due_idx" ON "appsumo_licenses" USING btree ("product_id","next_check_at") WHERE "appsumo_licenses"."next_check_at" is not null;--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD CONSTRAINT "appsumo_license_check_state" CHECK (("appsumo_licenses"."expected_status" is null or "appsumo_licenses"."expected_status" in ('active', 'deactivated')) and "appsumo_licenses"."check_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "appsumo_licenses" ADD CONSTRAINT "appsumo_license_check_lease" CHECK (("appsumo_licenses"."check_lease_token" is null) = ("appsumo_licenses"."check_lease_expires_at" is null));