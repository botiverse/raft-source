ALTER TABLE "servers" ALTER COLUMN "translation_enabled" SET DEFAULT false;--> statement-breakpoint
UPDATE "servers" SET "translation_enabled" = false;
