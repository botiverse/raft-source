CREATE TABLE "onboarding_email_journeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"journey_key" text DEFAULT 'new_user_day0_day1' NOT NULL,
	"release_mode" text NOT NULL,
	"qualified_at" timestamp with time zone NOT NULL,
	"day0_status" text DEFAULT 'pending' NOT NULL,
	"day0_email_id" text,
	"day0_sent_at" timestamp with time zone,
	"day1_status" text DEFAULT 'pending' NOT NULL,
	"day1_email_id" text,
	"day1_scheduled_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"cancel_reason" text,
	"last_error" text,
	"suppressed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_email_journeys" ADD CONSTRAINT "onboarding_email_journeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_onboarding_email_journeys_user_key" ON "onboarding_email_journeys" USING btree ("user_id","journey_key");--> statement-breakpoint
CREATE INDEX "idx_onboarding_email_journeys_user" ON "onboarding_email_journeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_email_journeys_email" ON "onboarding_email_journeys" USING btree ("email");