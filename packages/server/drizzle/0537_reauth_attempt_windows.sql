-- Password re-authentication gets its own per-person attempt window
-- (services/secondFactor/attemptWindow.ts), apart from the second step of
-- sign-in (second_factor_attempt_windows, 0532): wrong passwords sent from a
-- signed-in session lock only re-authentication, never the owner's second
-- step at sign-in.
--   reauth_attempt_windows  per person: claims of a re-authentication attempt
--                           in the current window and, once the window is
--                           used up, locked_until
--
-- The new table is empty, so its primary key and foreign key are instant; the
-- foreign key to users takes a short SHARE ROW EXCLUSIVE lock on users, no
-- scan of it. It is declared inline (one statement). No backfill: claims
-- counted so far stay in second_factor_attempt_windows and run out with their
-- window.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "reauth_attempt_windows" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "reauth_attempt_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
