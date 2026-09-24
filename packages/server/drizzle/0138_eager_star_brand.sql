ALTER TABLE "users" ALTER COLUMN "auto_translation_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "preferred_translation_mode" SET DEFAULT 'auto';--> statement-breakpoint
UPDATE "users"
SET "preferred_translation_mode" = 'off',
    "auto_translation_enabled" = false
WHERE "created_at" < timestamp with time zone '2026-07-06T16:48:15Z'
  AND "preferred_translation_mode" = 'manual'
  AND "auto_translation_enabled" = false
  AND "preferred_translation_display" = 'original';--> statement-breakpoint
UPDATE "users"
SET "preferred_translation_mode" = 'auto',
    "auto_translation_enabled" = true
WHERE "created_at" < timestamp with time zone '2026-07-06T16:48:15Z'
  AND "preferred_translation_mode" = 'manual';--> statement-breakpoint
UPDATE "users"
SET "preferred_translation_mode" = 'off',
    "auto_translation_enabled" = false
WHERE "created_at" >= timestamp with time zone '2026-07-06T16:48:15Z'
  AND "preferred_translation_mode" = 'manual';
