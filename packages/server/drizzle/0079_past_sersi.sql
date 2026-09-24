CREATE TABLE "server_agreements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_membership_agreement_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"agreement_id" uuid,
	"agreement_version" integer,
	"actor_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"signature_method" text,
	"signature_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_agreements" ADD CONSTRAINT "server_agreements_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_agreements" ADD CONSTRAINT "server_agreements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_membership_agreement_audit" ADD CONSTRAINT "server_membership_agreement_audit_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_membership_agreement_audit" ADD CONSTRAINT "server_membership_agreement_audit_agreement_id_server_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."server_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_membership_agreement_audit" ADD CONSTRAINT "server_membership_agreement_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_agreements_server_version" ON "server_agreements" USING btree ("server_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_agreements_active" ON "server_agreements" USING btree ("server_id") WHERE "server_agreements"."enabled" = true;--> statement-breakpoint
CREATE INDEX "idx_server_agreements_server" ON "server_agreements" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_server_membership_agreement_audit_server" ON "server_membership_agreement_audit" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_server_membership_agreement_audit_subject" ON "server_membership_agreement_audit" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_server_membership_agreement_audit_agreement" ON "server_membership_agreement_audit" USING btree ("agreement_id");