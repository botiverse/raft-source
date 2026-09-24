CREATE TABLE "user_legal_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"terms_url" text NOT NULL,
	"privacy_url" text NOT NULL,
	"source" text NOT NULL,
	"ip_hash" text,
	"user_agent_hash" text,
	"locale" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_auth_completions" ADD COLUMN "provider_display_name" text;--> statement-breakpoint
ALTER TABLE "social_auth_completions" ADD COLUMN "provider_avatar_url" text;--> statement-breakpoint
ALTER TABLE "user_legal_acceptances" ADD CONSTRAINT "user_legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_legal_acceptances_user" ON "user_legal_acceptances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_legal_acceptances_source" ON "user_legal_acceptances" USING btree ("source");