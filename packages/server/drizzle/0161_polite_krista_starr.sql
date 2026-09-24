CREATE TABLE "push_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"provider" text NOT NULL,
	"user_id" uuid,
	"server_id" uuid,
	"device_token" text NOT NULL,
	"topic" text NOT NULL,
	"env" text NOT NULL,
	"app_version" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_registrations_provider_check" CHECK ("push_registrations"."provider" IN ('apns')),
	CONSTRAINT "push_registrations_env_check" CHECK ("push_registrations"."env" IN ('sandbox', 'production'))
);
--> statement-breakpoint
ALTER TABLE "push_registrations" ADD CONSTRAINT "push_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_registrations" ADD CONSTRAINT "push_registrations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_registrations_installation_provider" ON "push_registrations" USING btree ("installation_id","provider");--> statement-breakpoint
CREATE INDEX "idx_push_registrations_binding" ON "push_registrations" USING btree ("user_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_push_registrations_provider_env" ON "push_registrations" USING btree ("provider","env");