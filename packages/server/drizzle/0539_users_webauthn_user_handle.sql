-- The WebAuthn user handle a person's passkeys are registered under
-- (services/secondFactor/passkeyManagement.ts), stored instead of derived:
--   users.webauthn_user_handle  32 random bytes written at the person's first
--                               passkey registration; for a person who
--                               registered passkeys before this column, the
--                               HMAC handle those passkeys already carry,
--                               written lazily the next time they register one
--                               (staging only; production has no passkeys yet)
--
-- A nullable column with no default on users: no table rewrite, no scan, a
-- short ACCESS EXCLUSIVE lock. No index and no unique constraint: nothing
-- looks a person up by handle (sign-in finds a passkey by its credential id),
-- and the value is random (or a per-person HMAC), so duplicates are not a
-- concern worth a build over users. No backfill.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "webauthn_user_handle" "bytea";
