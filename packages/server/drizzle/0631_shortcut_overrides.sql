-- #proj-frontend:#37: the keyboard shortcuts a person changed, per account (null = every default; shared
-- shortcutOverrides.ts). One catalog-only ADD COLUMN (nullable, no default): no table rewrite. Give up after 2 s
-- rather than queue sign-ins behind a long transaction on users (the deploy runner retries a lock timeout).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shortcut_overrides" json;
