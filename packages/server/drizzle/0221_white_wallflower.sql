ALTER TABLE "users" ADD COLUMN "password_credential_established_at" timestamp with time zone;
--> statement-breakpoint
-- Historical password registrations had no explicit credential-presence fact.
-- Backfill only rows whose provenance is unambiguous: an account with no social
-- identity could only have been created through the password path before unlink
-- existed, while a legal signup/invite acceptance also names that path even if
-- the human linked a provider later. Legacy rows with both a social identity and
-- no provenance remain NULL and must establish a password through the verified
-- reset-email flow before removing their final identity.
UPDATE "users" AS "u"
SET "password_credential_established_at" = "u"."created_at"
WHERE NOT EXISTS (
  SELECT 1
  FROM "user_auth_identities" AS "identity"
  WHERE "identity"."user_id" = "u"."id"
)
OR EXISTS (
  SELECT 1
  FROM "user_legal_acceptances" AS "acceptance"
  WHERE "acceptance"."user_id" = "u"."id"
    AND "acceptance"."source" IN ('signup', 'invite')
);
