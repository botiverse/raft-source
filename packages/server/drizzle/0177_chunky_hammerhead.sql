ALTER TABLE "users" ADD COLUMN "first_observed_timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_observed_timezone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_timezone_observation_consistent" CHECK ((
      "users"."first_observed_timezone" IS NULL
      AND "users"."first_observed_timezone_at" IS NULL
    ) OR (
      length(btrim("users"."first_observed_timezone")) > 0
      AND "users"."first_observed_timezone_at" IS NOT NULL
    ));