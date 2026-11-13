-- SSO v1 SAML (rfcs/083-server-sso.md §5, §7): the AuthnRequest ID a
-- sign-in leg waits for (InResponseTo), and the assertion IDs already
-- accepted per connection (replay protection, swept after expiry). A
-- nullable column on a small table and a new table; give up after 5 s
-- rather than queue sign-ins behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "saml_assertion_replay" (
	"connection_id" uuid NOT NULL,
	"assertion_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saml_assertion_replay_connection_id_assertion_id_pk" PRIMARY KEY("connection_id","assertion_id")
);
--> statement-breakpoint
ALTER TABLE "sso_auth_transactions" ADD COLUMN "saml_request_id" text;--> statement-breakpoint
ALTER TABLE "saml_assertion_replay" ADD CONSTRAINT "saml_assertion_replay_connection_id_server_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."server_sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_saml_assertion_replay_expires" ON "saml_assertion_replay" USING btree ("expires_at");