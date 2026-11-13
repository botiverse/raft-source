-- Two-step verification (passkey / TOTP second factor), data only: nothing
-- reads these yet (services/secondFactor/). New tables:
--   webauthn_credentials  a person's passkeys (raw credential id, COSE public
--                         key, sign counter and backup flags, revoked_at)
--   user_totp             one encrypted authenticator-app secret per person,
--                         confirmed_at, last_used_step (replay guard)
--   user_backup_codes     single-use backup codes, argon2 hashes only
--   auth_challenges       short-lived single-use challenges (WebAuthn
--                         registration/assertion, the second-factor step of
--                         a sign-in), SHA-256 hash only
-- and on existing tables: users.second_factor_required_at (null = off),
-- session_families.second_factor_verified_at / second_factor_method, and the
-- web session family that approved an app login or a device login
-- (app_login_requests / device_authorizations.approver_family_id). No
-- backfill: approvals before this keep NULL.
--
-- The new tables are empty, so their foreign keys and indexes are instant;
-- each foreign key to users takes a short SHARE ROW EXCLUSIVE lock on users,
-- no scan of it.
--
-- Nullable columns with no default: no table rewrite, no scan. The foreign
-- keys on existing tables are NOT VALID (every existing value is NULL, so
-- there is nothing to validate; new rows are checked as they are written),
-- each taking a short SHARE ROW EXCLUSIVE lock on session_families. ON DELETE
-- SET NULL like the other pointers to a family (a family row goes only with
-- its user). app_login_requests and device_authorizations are small, so the
-- plain index builds are short. The session_families CHECK is NOT VALID too:
-- the new columns are NULL on every row, which it accepts.
--
-- Lock order keeps the hot tables' ACCESS EXCLUSIVE locks last and short:
-- the small tables first, then session_families, then users.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"flow" text,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "auth_challenges_kind_check" CHECK ("auth_challenges"."kind" IN ('webauthn_registration', 'webauthn_assertion', 'second_factor_login'))
);
--> statement-breakpoint
CREATE TABLE "user_backup_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"aaguid" text,
	"backup_eligible" boolean DEFAULT false NOT NULL,
	"backup_state" boolean DEFAULT false NOT NULL,
	"transports" text[],
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_backup_codes" ADD CONSTRAINT "user_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_user_kind" ON "auth_challenges" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_auth_challenges_expires_at" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_user_backup_codes_user" ON "user_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_webauthn_credentials_user" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD COLUMN "approver_family_id" uuid;--> statement-breakpoint
ALTER TABLE "app_login_requests" ADD CONSTRAINT "app_login_requests_approver_family_id_session_families_id_fk" FOREIGN KEY ("approver_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_app_login_requests_approver_family" ON "app_login_requests" USING btree ("approver_family_id");--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "approver_family_id" uuid;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_approver_family_id_session_families_id_fk" FOREIGN KEY ("approver_family_id") REFERENCES "public"."session_families"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_device_authorizations_approver_family" ON "device_authorizations" USING btree ("approver_family_id");--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "second_factor_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "second_factor_method" text;--> statement-breakpoint
ALTER TABLE "session_families" ADD CONSTRAINT "session_families_second_factor_check" CHECK (("session_families"."second_factor_verified_at" IS NULL AND "session_families"."second_factor_method" IS NULL) OR ("session_families"."second_factor_verified_at" IS NOT NULL AND "session_families"."second_factor_method" IS NOT NULL AND "session_families"."second_factor_method" IN ('passkey', 'totp', 'backup_code'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "second_factor_required_at" timestamp with time zone;
