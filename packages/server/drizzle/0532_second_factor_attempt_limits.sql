-- Two-step verification attempt limits and the re-authentication marker,
-- data only: nothing reads these yet (services/secondFactor/).
--   second_factor_attempt_windows  per person: claims of a second-step
--                                  attempt in the current window and, once
--                                  the window is used up, locked_until
--   session_families.reauthenticated_at  when the sign-in last proved the
--                                  person again (before adding a passkey)
--
-- The new table is empty, so its primary key and foreign key are instant; the
-- foreign key to users takes a short SHARE ROW EXCLUSIVE lock on users, no
-- scan of it. It is declared inline (one statement).
--
-- session_families gets a nullable column with no default: no table rewrite,
-- no scan, a short ACCESS EXCLUSIVE lock. No constraint, so nothing to
-- validate. No backfill: existing families keep NULL (their created_at still
-- counts as the sign-in's own proof).
--
-- Lock order keeps the hot table's ACCESS EXCLUSIVE lock last and short: the
-- new table (and its foreign key to users) first, then session_families.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "second_factor_attempt_windows" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "second_factor_attempt_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "session_families" ADD COLUMN "reauthenticated_at" timestamp with time zone;
