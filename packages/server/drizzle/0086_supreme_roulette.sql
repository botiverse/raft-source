ALTER TABLE "users" ADD COLUMN "preferred_translation_display" text DEFAULT 'translated' NOT NULL;
UPDATE "users" SET "preferred_translation_display" = 'original' WHERE "auto_translation_enabled" = false;
