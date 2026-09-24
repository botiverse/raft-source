CREATE TABLE "social_auth_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"intended_action" text NOT NULL,
	"user_id" uuid,
	"provider_user_id" text,
	"provider_email" text,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_auth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_auth_completions" ADD CONSTRAINT "social_auth_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_auth_identities" ADD CONSTRAINT "user_auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_social_auth_completions_code_hash" ON "social_auth_completions" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_social_auth_completions_expires_at" ON "social_auth_completions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_auth_identities_provider_user" ON "user_auth_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_auth_identities_user_provider" ON "user_auth_identities" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_user_auth_identities_user" ON "user_auth_identities" USING btree ("user_id");