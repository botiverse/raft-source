-- oauth_clients.login_mode (RFC 079 §5.1, §5.10; phase 0, no behaviour
-- change): `server` is today's Login with Raft, bound to one Server; `account`
-- is reserved for account-mode login, which nothing sets or reads yet. Every
-- existing app reads `server` through the default, and so does every app
-- created from now on (no write path names the column).
-- A text column with a named CHECK, like oauth_clients_publish_status_valid.
-- ADD COLUMN with a constant default is catalog-only on PostgreSQL 11+ (no
-- rewrite). The CHECK is added in the same step, not NOT VALID + VALIDATE:
-- oauth_clients is small (hundreds of rows), and the ACCESS EXCLUSIVE lock
-- ADD COLUMN takes is held to commit anyway, so a separate VALIDATE would not
-- shorten it. Bound the lock wait: give up after 5 s (the deploy retries)
-- rather than queue every app read behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "login_mode" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_login_mode_valid" CHECK ("oauth_clients"."login_mode" IN ('server', 'account'));
