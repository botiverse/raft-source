-- Email recovery of two-step verification (services/secondFactor/recovery.ts):
--   second_factor_recovery_requests  one row per request: the emailed link
--                                    (pending_confirmation, 30 minutes), the
--                                    72-hour wait (waiting, until eligible_at),
--                                    and how it ended (completed, cancelled,
--                                    expired). Tokens are SHA-256 hashes only.
--                                    At most one active row per person
--                                    (partial unique index).
--
-- The new table is empty: its constraints and indexes are instant; its
-- foreign key to users takes a short SHARE ROW EXCLUSIVE lock on users, no
-- scan of it. Nothing reads or writes it for a person who never asks.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "second_factor_recovery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"link_token_hash" text NOT NULL,
	"link_expires_at" timestamp with time zone NOT NULL,
	"cancel_token_hash" text,
	"requested_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"eligible_at" timestamp with time zone,
	"ready_notified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"expired_at" timestamp with time zone,
	CONSTRAINT "second_factor_recovery_requests_link_token_hash_unique" UNIQUE("link_token_hash"),
	CONSTRAINT "second_factor_recovery_requests_cancel_token_hash_unique" UNIQUE("cancel_token_hash"),
	CONSTRAINT "second_factor_recovery_requests_status_valid" CHECK ("second_factor_recovery_requests"."status" IN ('pending_confirmation', 'waiting', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "second_factor_recovery_requests_cancelled_by_valid" CHECK ("second_factor_recovery_requests"."cancelled_by" IS NULL OR "second_factor_recovery_requests"."cancelled_by" IN ('user', 'token', 'auto_factor')),
	CONSTRAINT "second_factor_recovery_requests_waiting_times" CHECK ("second_factor_recovery_requests"."status" = 'pending_confirmation' OR "second_factor_recovery_requests"."status" = 'expired' OR "second_factor_recovery_requests"."status" = 'cancelled' OR ("second_factor_recovery_requests"."confirmed_at" IS NOT NULL AND "second_factor_recovery_requests"."eligible_at" IS NOT NULL AND "second_factor_recovery_requests"."cancel_token_hash" IS NOT NULL)),
	CONSTRAINT "second_factor_recovery_requests_end_times" CHECK (("second_factor_recovery_requests"."status" <> 'completed' OR "second_factor_recovery_requests"."completed_at" IS NOT NULL) AND ("second_factor_recovery_requests"."status" <> 'cancelled' OR ("second_factor_recovery_requests"."cancelled_at" IS NOT NULL AND "second_factor_recovery_requests"."cancelled_by" IS NOT NULL)) AND ("second_factor_recovery_requests"."status" <> 'expired' OR "second_factor_recovery_requests"."expired_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "second_factor_recovery_requests" ADD CONSTRAINT "second_factor_recovery_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_second_factor_recovery_requests_user_active" ON "second_factor_recovery_requests" USING btree ("user_id") WHERE status IN ('pending_confirmation', 'waiting');--> statement-breakpoint
CREATE INDEX "idx_second_factor_recovery_requests_user_requested" ON "second_factor_recovery_requests" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "idx_second_factor_recovery_requests_waiting_eligible" ON "second_factor_recovery_requests" USING btree ("eligible_at") WHERE status = 'waiting';