ALTER TABLE "agent_scopes" ADD COLUMN "mode" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
UPDATE "agent_scopes" SET "mode" = 'custom';
