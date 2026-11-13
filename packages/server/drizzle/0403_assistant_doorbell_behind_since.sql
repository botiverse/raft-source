ALTER TABLE "assistant_doorbells" ADD COLUMN "behind_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assistant_doorbells" ADD COLUMN "behind_sources" text;--> statement-breakpoint
ALTER TABLE "assistant_doorbells" ADD COLUMN "behind_first_since" timestamp with time zone;