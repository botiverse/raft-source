-- Loopback login for device authorizations (design: one-click Computer login
-- when the browser is on the same machine, RFC 8252 + PKCE S256):
--   mode                      device | loopback, 'device' for every existing
--                             row (a constant default: catalog only, no rewrite).
--   request_id                loopback: the unguessable id in the approval link;
--                             unique (all NULL today, so the index builds on
--                             an empty key set).
--   return_uri, code_challenge
--                             loopback: where approve sends the browser, and
--                             the PKCE S256 challenge the token phase checks.
--   callback_code_hash, callback_code_expires_at
--                             loopback: the one-time code approve issued
--                             (sha256), redeemable for 2 minutes, once.
--   device_code_lookup_hash, device_code_hash, user_code DROP NOT NULL
--                             a loopback row has no device code or user code.
--                             Device rows keep writing all three.
--
-- device_authorizations is not a hot table, and small (one row per login
-- attempt). ACCESS EXCLUSIVE for the ALTERs and the unique index build on the
-- new all-NULL column; the lock wait is bounded so a long transaction on the
-- table makes the deploy retry instead of queueing logins behind it.
-- Rolling deploy: an older replica never reads the new columns, writes
-- device rows only (mode defaults to 'device'), and still finds them by
-- user_code / device_code_lookup_hash, which device rows always set.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "device_authorizations" ALTER COLUMN "device_code_lookup_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_authorizations" ALTER COLUMN "device_code_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_authorizations" ALTER COLUMN "user_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "mode" text DEFAULT 'device' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "return_uri" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "callback_code_hash" text;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "callback_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_request_id_unique" UNIQUE("request_id");