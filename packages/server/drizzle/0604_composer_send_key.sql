-- #triage:#210: how the message box sends, per account (null = the default,
-- Enter sends; "mod_enter" = ⌘/Ctrl+Enter sends). One catalog-only ADD COLUMN
-- (nullable, no default): no table rewrite. Give up after 2 s rather than
-- queue sign-ins behind a long transaction on users (the deploy runner retries
-- a lock timeout).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "composer_send_key" text;
