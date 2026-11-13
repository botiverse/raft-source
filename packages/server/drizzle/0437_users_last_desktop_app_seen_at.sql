-- users.last_desktop_app_seen_at: when /auth/me last saw Raft Desktop
-- (X-Raft-Client-Platform: desktop_app), for the deep-link desktop banner.
-- Nullable, no default (metadata-only), but ADD COLUMN still takes an ACCESS
-- EXCLUSIVE lock and `users` is read on every request: give up after 5 s
-- rather than queue every users read behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_desktop_app_seen_at" timestamp with time zone;
