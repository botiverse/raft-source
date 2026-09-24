CREATE TABLE "newsletter_audience_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"audience_id" text NOT NULL,
	"resend_contact_id" text,
	"status" text DEFAULT 'synced' NOT NULL,
	"last_sync_error" text,
	"opted_out_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"email" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "newsletter_audience_contacts" ADD CONSTRAINT "newsletter_audience_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_newsletter_contacts_audience_email" ON "newsletter_audience_contacts" USING btree ("audience_id","email");--> statement-breakpoint
CREATE INDEX "idx_newsletter_contacts_user" ON "newsletter_audience_contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_newsletter_contacts_status" ON "newsletter_audience_contacts" USING btree ("status");