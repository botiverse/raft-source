-- Account deletion requests (services/accountDeletion; design "删除账号：服务端设计 v1" §2):
--   account_deletion_requests  one row per request: who asked (self or ops,
--                              actor, ticket), when, when it takes effect,
--                              and how it ended (pending, cancelled,
--                              completed). At most one pending row per person
--                              (partial unique index), which is also the
--                              per-request lookup auth makes for a pending
--                              person (middleware/auth.ts).
--   auth_challenges.kind       + account_deletion_email_code: the emailed
--                              code that confirms a deletion request for a
--                              person with neither a password nor two-step
--                              verification (services/accountDeletion/emailCode.ts).
-- user_retirement_receipts.environment gains `production` only in schema.ts:
-- it is a plain text column (no CHECK), so nothing changes here.
--
-- The new table is empty: its constraints and indexes are instant; its two
-- foreign keys to users take a short SHARE ROW EXCLUSIVE lock on users, no
-- scan of it. Re-adding the kind CHECK scans auth_challenges, a small table
-- of short-lived rows, under its ACCESS EXCLUSIVE lock; the new list is a
-- superset of the old one, so rows written by the previous release pass and
-- that release never writes the new kind.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" uuid,
	"ticket_ref" text,
	"requested_at" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"state" text NOT NULL,
	CONSTRAINT "account_deletion_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "account_deletion_requests_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "account_deletion_requests_source_valid" CHECK ("account_deletion_requests"."source" IN ('self', 'ops')),
	CONSTRAINT "account_deletion_requests_state_valid" CHECK ("account_deletion_requests"."state" IN ('pending', 'cancelled', 'completed')),
	CONSTRAINT "account_deletion_requests_ops_ticket" CHECK ("account_deletion_requests"."source" <> 'ops' OR "account_deletion_requests"."ticket_ref" IS NOT NULL),
	CONSTRAINT "account_deletion_requests_state_times" CHECK (("account_deletion_requests"."state" = 'pending' AND "account_deletion_requests"."cancelled_at" IS NULL AND "account_deletion_requests"."completed_at" IS NULL) OR ("account_deletion_requests"."state" = 'cancelled' AND "account_deletion_requests"."cancelled_at" IS NOT NULL AND "account_deletion_requests"."completed_at" IS NULL) OR ("account_deletion_requests"."state" = 'completed' AND "account_deletion_requests"."completed_at" IS NOT NULL AND "account_deletion_requests"."cancelled_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_deletion_requests_user_pending" ON "account_deletion_requests" USING btree ("user_id") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "idx_account_deletion_requests_pending_due" ON "account_deletion_requests" USING btree ("scheduled_for") WHERE state = 'pending';--> statement-breakpoint
ALTER TABLE "auth_challenges" DROP CONSTRAINT "auth_challenges_kind_check";--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_kind_check" CHECK ("auth_challenges"."kind" IN ('webauthn_registration', 'webauthn_assertion', 'second_factor_login', 'account_deletion_email_code'));
