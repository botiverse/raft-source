CREATE TABLE "integration_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid,
	"client_id" uuid,
	"event_type" text NOT NULL,
	"event_category" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"requester_type" text,
	"requester_id" uuid,
	"subject_type" text,
	"subject_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"correlation_id" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_audit_server_time" ON "integration_audit_events" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_integration_audit_client_time" ON "integration_audit_events" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_integration_audit_event_time" ON "integration_audit_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_integration_audit_outcome_time" ON "integration_audit_events" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "idx_integration_audit_actor_time" ON "integration_audit_events" USING btree ("actor_type","actor_id","created_at");