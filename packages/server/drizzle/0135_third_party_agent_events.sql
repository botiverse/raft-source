CREATE TABLE "third_party_agent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"access_token_id" uuid,
	"external_event_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"resource" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_access_requests" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "allowed_scopes" json;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_access_token_id_oauth_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "public"."oauth_access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_third_party_agent_events_agent_status" ON "third_party_agent_events" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_third_party_agent_events_client" ON "third_party_agent_events" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_third_party_agent_events_dedupe" ON "third_party_agent_events" USING btree ("client_id","agent_id","external_event_id");