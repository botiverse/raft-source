-- SSO sign-ins in flight (rfcs/083-server-sso.md §5.1, §5.2): one row per
-- sign-in leg, deleted when it completes or by the hourly sweep after its
-- 10-minute expiry. A new table only. The foreign keys take a brief lock on
-- `server_sso_connections` and `users`; give up after 5 s rather than queue
-- traffic behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "sso_auth_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"uses_draft" boolean DEFAULT false NOT NULL,
	"return_to" text,
	"app_return_uri" text,
	"app_code_challenge" text,
	"test_user_id" uuid,
	"status" text DEFAULT 'started' NOT NULL,
	"profile" jsonb,
	"completion_code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_auth_transactions" ADD CONSTRAINT "sso_auth_transactions_connection_id_server_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."server_sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_auth_transactions" ADD CONSTRAINT "sso_auth_transactions_test_user_id_users_id_fk" FOREIGN KEY ("test_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sso_auth_transactions_state" ON "sso_auth_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sso_auth_transactions_completion" ON "sso_auth_transactions" USING btree ("completion_code_hash");--> statement-breakpoint
CREATE INDEX "idx_sso_auth_transactions_expires" ON "sso_auth_transactions" USING btree ("expires_at");