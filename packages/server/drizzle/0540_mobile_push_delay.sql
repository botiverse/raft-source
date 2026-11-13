CREATE TABLE "notification_mobile_deferrals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outbox_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"extensions" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_mobile_deferrals_status_check" CHECK ("notification_mobile_deferrals"."status" IN ('pending', 'processing', 'sent', 'skipped', 'failed')),
	CONSTRAINT "notification_mobile_deferrals_window_check" CHECK ("notification_mobile_deferrals"."due_at" <= "notification_mobile_deferrals"."deadline_at")
);
--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD COLUMN "mobile_delay" text DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_mobile_deferrals" ADD CONSTRAINT "notification_mobile_deferrals_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_mobile_deferrals" ADD CONSTRAINT "notification_mobile_deferrals_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_mobile_deferrals_outbox" ON "notification_mobile_deferrals" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "idx_notification_mobile_deferrals_due" ON "notification_mobile_deferrals" USING btree ("due_at") WHERE "notification_mobile_deferrals"."status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_notification_mobile_deferrals_receiver" ON "notification_mobile_deferrals" USING btree ("receiver_id");--> statement-breakpoint
CREATE INDEX "idx_notification_mobile_deferrals_processed" ON "notification_mobile_deferrals" USING btree ("processed_at") WHERE "notification_mobile_deferrals"."processed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_mobile_delay_check" CHECK ("user_notification_settings"."mobile_delay" IN ('always', 'inactive', '1m', '2m', '5m', '10m'));