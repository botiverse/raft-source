ALTER TABLE "oauth_clients" ADD COLUMN "return_url" text;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD COLUMN "principal_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "principal_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD CONSTRAINT "oauth_access_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_access_requests_user" ON "oauth_access_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_access_tokens_user" ON "oauth_access_tokens" USING btree ("user_id");
