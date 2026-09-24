CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_code_lookup_hash" "bytea" NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"client_name" text,
	"approved_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"poll_interval_seconds" integer DEFAULT 5 NOT NULL,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"consumed_session_id" uuid,
	"consumed_ip" text,
	"consumed_user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_authorizations_device_code_lookup_hash_unique" UNIQUE("device_code_lookup_hash"),
	CONSTRAINT "device_authorizations_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_authorizations_approved_by" ON "device_authorizations" USING btree ("approved_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_device_authorizations_expires_at" ON "device_authorizations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE set null ON UPDATE no action;