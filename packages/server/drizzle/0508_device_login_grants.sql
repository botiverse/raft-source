-- One-time device-login grants (device-auth design v2 §3.1): a device login
-- that asks for one thing (attach machine X to server Y; a key for agent Z)
-- instead of a session. The next migration links the Computer row an attach
-- token issued to its grant (computers.key_issued_by_grant_id).
--
-- device_login_grants is new and empty: its table, indexes and foreign keys
-- cost nothing to build. The foreign keys to users, servers, agents and
-- device_authorizations take a short SHARE ROW EXCLUSIVE lock on those tables
-- (no scan of them). computers is changed in a migration of its own, so these
-- locks are released before anything waits for ACCESS EXCLUSIVE on computers.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "device_login_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_authorization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"machine_name" text,
	"hostname" text,
	"os" text,
	"requested_agent_id" uuid,
	"requested_user_agent" text,
	"approver_user_id" uuid,
	"server_id" uuid,
	"agent_id" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"attach_token_lookup_hash" "bytea",
	"attach_token_issued_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"consumed_computer_id" uuid,
	"consumed_agent_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_login_grants_device_authorization_id_unique" UNIQUE("device_authorization_id"),
	CONSTRAINT "device_login_grants_attach_token_lookup_hash_unique" UNIQUE("attach_token_lookup_hash")
);
--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD CONSTRAINT "device_login_grants_device_authorization_id_device_authorizations_id_fk" FOREIGN KEY ("device_authorization_id") REFERENCES "public"."device_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD CONSTRAINT "device_login_grants_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD CONSTRAINT "device_login_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_login_grants" ADD CONSTRAINT "device_login_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_login_grants_approver" ON "device_login_grants" USING btree ("approver_user_id");--> statement-breakpoint
CREATE INDEX "idx_device_login_grants_server" ON "device_login_grants" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_device_login_grants_agent" ON "device_login_grants" USING btree ("agent_id");