-- Prepaid Pro (task #19 in #proj-commercial; docs/billing/prepaid-pro.md): one
-- new, empty table. Nothing writes it until the prepaid checkout is turned on
-- for a Server (`pro_prepaid`), and older server code never names it, so
-- rolling back leaves it unused. The foreign keys take SHARE ROW EXCLUSIVE
-- locks on `servers` and `users`: give up after 5 s rather than queue behind a
-- long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "prepaid_pro_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid,
	"kind" text NOT NULL,
	"months" integer,
	"seat_quantity" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"conflict_reason" text,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_customer_id" text,
	"stripe_refund_id" text,
	"amount_total" integer NOT NULL,
	"currency" text NOT NULL,
	"purchased_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prepaid_pro_purchases_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id"),
	CONSTRAINT "prepaid_pro_purchase_months_valid" CHECK (("prepaid_pro_purchases"."kind" = 'period' AND "prepaid_pro_purchases"."months" IN (1, 3, 12))
    OR ("prepaid_pro_purchases"."kind" = 'seats' AND "prepaid_pro_purchases"."months" IS NULL)),
	CONSTRAINT "prepaid_pro_purchase_seats_positive" CHECK ("prepaid_pro_purchases"."seat_quantity" > 0),
	CONSTRAINT "prepaid_pro_purchase_window_valid" CHECK ("prepaid_pro_purchases"."ends_at" > "prepaid_pro_purchases"."starts_at"),
	CONSTRAINT "prepaid_pro_purchase_amount_valid" CHECK ("prepaid_pro_purchases"."amount_total" >= 0),
	CONSTRAINT "prepaid_pro_purchase_conflict_reason" CHECK (("prepaid_pro_purchases"."status" = 'conflict') = ("prepaid_pro_purchases"."conflict_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "prepaid_pro_purchases" ADD CONSTRAINT "prepaid_pro_purchases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_pro_purchases" ADD CONSTRAINT "prepaid_pro_purchases_purchased_by_user_id_users_id_fk" FOREIGN KEY ("purchased_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prepaid_pro_purchases_server_ends" ON "prepaid_pro_purchases" USING btree ("server_id","ends_at");--> statement-breakpoint
CREATE INDEX "idx_prepaid_pro_purchases_payment_intent" ON "prepaid_pro_purchases" USING btree ("stripe_payment_intent_id");