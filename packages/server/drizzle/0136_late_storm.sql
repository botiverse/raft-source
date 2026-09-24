ALTER TABLE "users" ALTER COLUMN "auto_translation_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_translation_mode" text DEFAULT 'manual' NOT NULL;