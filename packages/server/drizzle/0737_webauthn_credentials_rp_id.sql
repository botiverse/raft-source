-- Passkeys move from RP ID raft.build to app.raft.build (WEBAUTHN_LEGACY_RP_ID,
-- services/secondFactor/webauthn.ts): each passkey records the RP ID it was registered
-- under. NULL = registered before this column (under the RP ID then configured); not
-- backfilled, the server reads NULL as WEBAUTHN_LEGACY_RP_ID when set, else WEBAUTHN_RP_ID.
--
-- A nullable column without a default: catalog only, no rewrite. webauthn_credentials is
-- small and not hot; the lock wait is bounded anyway. Rolling deploy: an older replica
-- neither reads nor writes the column (its new rows stay NULL, read as the RP ID it used).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD COLUMN "rp_id" text;
