CREATE TABLE "paid_lifecycle_journeys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"first_paid_at" timestamp with time zone NOT NULL,
	"contact_id" text,
	"contact_email" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"needs_sync" boolean DEFAULT true NOT NULL,
	"refresh_after" timestamp with time zone,
	"trigger_state" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_lifecycle_journeys_id_unique" UNIQUE("id"),
	CONSTRAINT "paid_lifecycle_journeys_contact_id_unique" UNIQUE("contact_id"),
	CONSTRAINT "paid_lifecycle_trigger_state" CHECK ("paid_lifecycle_journeys"."trigger_state" IN ('pending','attempted','accepted','unknown','suppressed'))
);
--> statement-breakpoint
CREATE TABLE "paid_lifecycle_payments" (
	"invoice_id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"payer_user_id" uuid,
	"stripe_subscription_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"amount" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	CONSTRAINT "paid_lifecycle_payment_positive" CHECK ("paid_lifecycle_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "paid_lifecycle_receipts" (
	"email_id" uuid PRIMARY KEY NOT NULL,
	"journey_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"needs_sync" boolean DEFAULT true NOT NULL,
	CONSTRAINT "paid_lifecycle_receipt_kind" CHECK ("paid_lifecycle_receipts"."kind" IN ('welcome','checkin'))
);
--> statement-breakpoint
ALTER TABLE "paid_lifecycle_journeys" ADD CONSTRAINT "paid_lifecycle_journeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_lifecycle_payments" ADD CONSTRAINT "paid_lifecycle_payments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_lifecycle_payments" ADD CONSTRAINT "paid_lifecycle_payments_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_lifecycle_receipts" ADD CONSTRAINT "paid_lifecycle_receipts_journey_id_paid_lifecycle_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."paid_lifecycle_journeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_paid_lifecycle_dirty" ON "paid_lifecycle_journeys" USING btree ("needs_sync","lease_until","user_id");--> statement-breakpoint
CREATE INDEX "idx_paid_lifecycle_expiry" ON "paid_lifecycle_journeys" USING btree ("refresh_after");--> statement-breakpoint
CREATE INDEX "idx_paid_lifecycle_payment_server" ON "paid_lifecycle_payments" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_paid_lifecycle_payment_charge" ON "paid_lifecycle_payments" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "idx_paid_lifecycle_receipt_pending" ON "paid_lifecycle_receipts" USING btree ("needs_sync","email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_paid_lifecycle_receipt_step" ON "paid_lifecycle_receipts" USING btree ("journey_id","kind");
--> statement-breakpoint
-- Only registered journeys are dirtied; no enrollment/backfill or waiting-cohort
-- scan. These changes are durable in the SAME business transaction, including
-- crashes before an application-level immediate sync can start.
CREATE FUNCTION paid_lifecycle_dirty_server(target uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE paid_lifecycle_journeys SET needs_sync=true, revision=revision+1, updated_at=now()
 WHERE user_id IN (
   SELECT user_id FROM server_members WHERE server_id=target AND role='owner'
   UNION SELECT created_by_user_id FROM subscriptions WHERE server_id=target
 );
$$;
CREATE FUNCTION paid_lifecycle_business_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
   UPDATE paid_lifecycle_journeys SET needs_sync=true,revision=revision+1,updated_at=now() WHERE user_id=NEW.id;
 ELSIF TG_TABLE_NAME='servers' THEN
   PERFORM paid_lifecycle_dirty_server(OLD.id);
 ELSE
   IF TG_OP != 'INSERT' THEN PERFORM paid_lifecycle_dirty_server(OLD.server_id); END IF;
   IF TG_OP != 'DELETE' THEN PERFORM paid_lifecycle_dirty_server(NEW.server_id); END IF;
   IF TG_TABLE_NAME='server_members' THEN
     IF TG_OP != 'INSERT' THEN
       UPDATE paid_lifecycle_journeys SET needs_sync=true,revision=revision+1,updated_at=now() WHERE user_id=OLD.user_id;
     END IF;
     IF TG_OP != 'DELETE' THEN
       UPDATE paid_lifecycle_journeys SET needs_sync=true,revision=revision+1,updated_at=now() WHERE user_id=NEW.user_id;
     END IF;
   ELSIF TG_TABLE_NAME='subscriptions' THEN
     IF TG_OP != 'INSERT' THEN
       UPDATE paid_lifecycle_journeys SET needs_sync=true,revision=revision+1,updated_at=now() WHERE user_id=OLD.created_by_user_id;
     END IF;
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER paid_lifecycle_subscriptions_dirty AFTER INSERT OR UPDATE OR DELETE ON subscriptions FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_business_dirty();
CREATE TRIGGER paid_lifecycle_members_dirty AFTER UPDATE OR DELETE ON server_members FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_business_dirty();
CREATE TRIGGER paid_lifecycle_members_insert_dirty AFTER INSERT ON server_members FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_business_dirty();
CREATE TRIGGER paid_lifecycle_servers_dirty BEFORE UPDATE OF plan,deleted_at OR DELETE ON servers FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_business_dirty();
CREATE TRIGGER paid_lifecycle_user_email_dirty AFTER UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_business_dirty();
--> statement-breakpoint
-- Current AppSumo grants suppress this campaign, not future subscriptions.
-- Dirty registered journeys transactionally when the selected license or its
-- binding changes, even if servers.plan remains Pro. No enrollment or mail here.
CREATE FUNCTION paid_lifecycle_appsumo_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='appsumo_license_bindings' THEN
   IF TG_OP != 'INSERT' THEN PERFORM paid_lifecycle_dirty_server(OLD.server_id); END IF;
   IF TG_OP != 'DELETE' THEN PERFORM paid_lifecycle_dirty_server(NEW.server_id); END IF;
 ELSE
   FOR target IN SELECT server_id FROM appsumo_license_bindings
     WHERE (TG_OP != 'INSERT' AND product_id=OLD.product_id AND current_license_key=OLD.license_key)
        OR (TG_OP != 'DELETE' AND product_id=NEW.product_id AND current_license_key=NEW.license_key)
   LOOP
     PERFORM paid_lifecycle_dirty_server(target);
   END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER paid_lifecycle_appsumo_binding_dirty AFTER INSERT OR UPDATE OR DELETE ON appsumo_license_bindings FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_appsumo_dirty();
CREATE TRIGGER paid_lifecycle_appsumo_license_dirty AFTER INSERT OR UPDATE OR DELETE ON appsumo_licenses FOR EACH ROW EXECUTE FUNCTION paid_lifecycle_appsumo_dirty();
