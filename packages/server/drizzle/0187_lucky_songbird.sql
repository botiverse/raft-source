ALTER TABLE "users" ADD COLUMN "last_observed_timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_observed_timezone_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users"
SET
  "last_observed_timezone" = "first_observed_timezone",
  "last_observed_timezone_at" = "first_observed_timezone_at"
WHERE "first_observed_timezone" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_timezone_observation_consistent" CHECK ((
      "users"."first_observed_timezone" IS NULL
      AND "users"."last_observed_timezone" IS NULL
      AND "users"."last_observed_timezone_at" IS NULL
    ) OR (
      "users"."first_observed_timezone" IS NOT NULL
      AND "users"."last_observed_timezone" IS NULL
      AND "users"."last_observed_timezone_at" IS NULL
    ) OR (
      "users"."first_observed_timezone" IS NOT NULL
      AND length(btrim("users"."last_observed_timezone")) > 0
      AND "users"."last_observed_timezone_at" IS NOT NULL
      AND "users"."last_observed_timezone_at" >= "users"."first_observed_timezone_at"
    ));
