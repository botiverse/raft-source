ALTER TABLE "agents" ADD COLUMN "voice_askable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "voice_callable" boolean DEFAULT true NOT NULL;