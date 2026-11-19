-- RFC 086 §5.2: the public key an App registers for card SecretInputs, on its
-- link-preview registration (PUT /api/oauth/link-preview/encryption-key, the
-- App's own Basic client credentials only). The P-256 ECDH-ES JWK (public
-- members only), its kid and when it was set; a new key replaces it, deleting
-- the registration removes it. The three columns are set and cleared together
-- by appCardEncryptionKeyService.ts.
--
-- Additive. Nullable columns without a default rewrite no rows; older servers
-- ignore them. No CHECK ties the three columns together: they are written
-- together in one place, under a lock on the row.
-- Locks: ACCESS EXCLUSIVE on oauth_app_link_previews (read by every link
-- preview and card read) for the catalog change only: wait at most 2 s.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "card_encryption_key" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "card_encryption_kid" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "card_encryption_key_set_at" timestamp with time zone;
