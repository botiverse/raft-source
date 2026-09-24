ALTER TABLE "social_auth_completions" ALTER COLUMN "code_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "social_auth_completions" ADD COLUMN "status" text DEFAULT 'provider_completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_auth_completions" ADD COLUMN "code_challenge" text;--> statement-breakpoint
CREATE INDEX "idx_social_auth_completions_user" ON "social_auth_completions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_social_auth_completions_status" ON "social_auth_completions" USING btree ("status");
