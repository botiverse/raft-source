-- The role a person left a Server with (RFC 083 §6.1): SSO auto-join never
-- turns a Guest who left into a member. NULL on rows from before. A nullable
-- column with no default is metadata-only.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "server_membership_departures" ADD COLUMN "role" text;
