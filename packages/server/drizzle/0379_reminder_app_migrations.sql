CREATE TABLE "reminder_app_migrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_code" text,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reminder_app_migrations" ADD CONSTRAINT "reminder_app_migrations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_reminder_app_migrations_install" ON "reminder_app_migrations" USING btree ("server_id","install_id");--> statement-breakpoint
CREATE INDEX "idx_reminder_app_migrations_state" ON "reminder_app_migrations" USING btree ("state","next_attempt_at");