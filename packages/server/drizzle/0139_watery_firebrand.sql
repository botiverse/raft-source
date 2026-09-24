ALTER TABLE "users" ALTER COLUMN "auto_translation_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "preferred_translation_mode" SET DEFAULT 'off';--> statement-breakpoint
UPDATE "users"
SET "preferred_translation_mode" = 'off',
    "auto_translation_enabled" = false
WHERE "created_at" >= timestamp with time zone '2026-07-06T16:48:15Z'
  AND "preferred_translation_mode" = 'auto';
