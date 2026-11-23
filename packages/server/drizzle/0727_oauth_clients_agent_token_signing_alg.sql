-- oauth_clients.agent_token_signing_alg: how Raft signs one App's agent tokens
-- (agent audience JWTs). ES256 is today's behaviour and the default for every
-- existing and new App; RS256 is for relying parties that accept only RSA keys
-- (Alibaba Cloud's OIDC provider). The App's owner/admin sets it; the token
-- request never chooses it. ID tokens and callback assertions stay ES256.
-- A text column with a named CHECK, like oauth_clients_login_mode_valid.
-- ADD COLUMN with a constant default is catalog-only on PostgreSQL 11+ (no
-- rewrite). The CHECK is added NOT VALID and stays so: the column is new in
-- this migration and every row holds only its default, so there is no old data
-- to validate; every write from now on is checked. No separate VALIDATE.
-- Bound the lock wait: give up after 5 s (the deploy retries) rather than
-- queue every App read behind a long transaction.
-- Rollback: the previous release never reads the column; drop it freely.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "agent_token_signing_alg" text DEFAULT 'ES256' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_agent_token_signing_alg_valid" CHECK ("oauth_clients"."agent_token_signing_alg" IN ('ES256', 'RS256')) NOT VALID;
