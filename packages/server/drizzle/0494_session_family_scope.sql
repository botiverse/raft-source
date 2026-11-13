-- A session family's scope, kept across every refresh: `full` (a person's own
-- sign-in; every existing family) or `device` (issued by a device login: only
-- the routes Raft Computer and the raft CLI call, 7-day refresh window).
-- A constant default: metadata-only on Postgres 11+, no table rewrite.
ALTER TABLE "session_families" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;