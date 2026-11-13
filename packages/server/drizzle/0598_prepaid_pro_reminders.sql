-- Prepaid Pro reminders (task #19 in #proj-commercial; docs/billing/prepaid-pro.md):
-- one new, empty table, and an index on `prepaid_pro_purchases` for the
-- hourly end-date scans (lapse sweep, reminders). That table is empty in
-- production (`pro_prepaid` is off everywhere and no Prices exist), so the
-- plain CREATE INDEX holds its lock for no time. Only the reminder job writes
-- the new table, and older server code never names it, so rolling back leaves
-- it unused. The foreign keys take SHARE ROW EXCLUSIVE locks on
-- `prepaid_pro_purchases` and `users`: give up after 5 s rather than queue
-- behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "prepaid_pro_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purchase_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"recipient_user_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"email_id" text,
	CONSTRAINT "prepaid_pro_reminder_kind_valid" CHECK ("prepaid_pro_reminders"."kind" IN ('ends_in_7_days', 'ends_in_1_day', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "prepaid_pro_reminders" ADD CONSTRAINT "prepaid_pro_reminders_purchase_id_prepaid_pro_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."prepaid_pro_purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_pro_reminders" ADD CONSTRAINT "prepaid_pro_reminders_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prepaid_pro_reminders_purchase_kind" ON "prepaid_pro_reminders" USING btree ("purchase_id","kind");--> statement-breakpoint
CREATE INDEX "idx_prepaid_pro_purchases_period_ends" ON "prepaid_pro_purchases" USING btree ("ends_at") WHERE "prepaid_pro_purchases"."kind" = 'period';