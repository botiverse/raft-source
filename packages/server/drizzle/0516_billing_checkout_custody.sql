CREATE TABLE "billing_checkout_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"state" text NOT NULL,
	"stripe_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkout_attempt_state_valid" CHECK (("billing_checkout_attempts"."state" = 'known' AND "billing_checkout_attempts"."stripe_session_id" IS NOT NULL)
    OR ("billing_checkout_attempts"."state" IN ('creating', 'ambiguous') AND "billing_checkout_attempts"."stripe_session_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "billing_source_guards" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"bind_lease_token" uuid,
	"bind_lease_expires_at" timestamp with time zone,
	CONSTRAINT "billing_source_guard_lease_valid" CHECK (("billing_source_guards"."bind_lease_token" IS NULL) = ("billing_source_guards"."bind_lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_source_guards" ADD CONSTRAINT "billing_source_guards_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_checkout_attempt_server" ON "billing_checkout_attempts" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_checkout_attempt_session" ON "billing_checkout_attempts" USING btree ("stripe_session_id");