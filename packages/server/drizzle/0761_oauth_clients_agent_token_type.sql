-- oauth_clients.agent_token_type: the JOSE `typ` header of one App's agent
-- tokens (agent audience JWTs). at+jwt is today's behaviour and the default for
-- every existing and new App; JWT is for relying parties that refuse any other
-- type (Alibaba Cloud STS AssumeRoleWithOIDC). The App's owner/admin sets it;
-- the token request never chooses it.
-- at+jwt keeps an agent token from passing for an ID token (same aud, the App's
-- client id), so JWT is allowed only on an App without a redirect URL, which
-- nobody can sign in to: oauth_clients_agent_token_type_token_only backs the
-- service-layer refusal, so no write path can store JWT next to a redirect URL.
-- Text columns with named CHECKs, like oauth_clients_agent_token_signing_alg_valid.
-- ADD COLUMN with a constant default is catalog-only on PostgreSQL 11+ (no
-- rewrite). Both CHECKs are added NOT VALID and stay so: the column is new in
-- this migration and every row holds its default at+jwt, which satisfies both,
-- so there is no old data to validate; every write from now on is checked. No
-- separate VALIDATE.
-- Bound the lock wait: give up after 5 s (the deploy retries) rather than
-- queue every App read behind a long transaction.
-- Rollback: the previous release never reads the column; drop it freely.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "agent_token_type" text DEFAULT 'at+jwt' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_agent_token_type_valid" CHECK ("oauth_clients"."agent_token_type" IN ('at+jwt', 'JWT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_agent_token_type_token_only" CHECK ("oauth_clients"."agent_token_type" = 'at+jwt' OR "oauth_clients"."return_url" IS NULL) NOT VALID;
