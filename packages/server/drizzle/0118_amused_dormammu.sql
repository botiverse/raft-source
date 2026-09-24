ALTER TABLE "email_verifications" ADD COLUMN "otp_hash" text;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "otp_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD COLUMN "otp_attempts" integer DEFAULT 0 NOT NULL;